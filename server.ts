/**
 * BlorkoBot alert server — polls USGS earthquakes and NWS weather alerts,
 * posts new events to MeshCore channels via Remote Terminal API.
 *
 * Usage: node --experimental-strip-types --env-file=.env --watch server.ts
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_BASE = "http://127.0.0.1:4042";
const COMPANION_API_BASE = "http://127.0.0.1:4043";

// Daily reboot of attached radios (Heltec + companion) at 4am local time —
// clears any stuck state from long-running radio firmware.
const DAILY_REBOOT_HOUR = 4;

// MeshCore channel keys (hex). Fill in for your own deployment.
const CHANNELS = {
  quake: "",
  weather: "",
  fire: "",
  space: "",
  power: "",
  alert: "",
  bot: "",
};

// Bounding box: Bay Area + surrounding (from USGS-NWS-PLAN.md)
const QUAKE_BBOX = { minLat: 36.5, maxLat: 39.0, minLon: -123.5, maxLon: -120.5 };
const QUAKE_MIN_MAG = 2.5;
const QUAKE_POLL_MS = 60_000;

const NWS_ZONES = "CAZ006,CAZ508,CAZ505,CAZ507,CAZ512,CAZ529,CAZ017,CAZ019";
const NWS_POLL_MS = 60_000;
const NWS_COOLDOWN_MS = 30 * 60_000; // 30 min — suppress same event type
const NWS_HIGH_SEVERITY = new Set(["Extreme", "Severe"]); // always post these

const FIRE_POLL_MS = 5 * 60_000; // 5 minutes — CAL FIRE updates infrequently
const SPACE_POLL_MS = 2 * 60_000; // 2 minutes
const POWER_POLL_MS = 5 * 60_000; // 5 minutes
const POWER_MIN_CUSTOMERS = 500; // only alert for significant outages

const RSS_URL = "https://bayareameshcore.com/rss.xml";
const RSS_POLL_MS = 15 * 60_000; // 15 minutes

const STATS_POLL_MS = 6 * 60 * 60_000; // 6 hours
const MSG_POLL_MS = 30_000; // 30s — low-traffic mesh, keep it responsive

// Optional: public key of a repeater whose telemetry we poll. Leave blank to disable.
const SR_REPEATER_KEY = "";

const STATS_FILE = new URL("./stats.jsonl", import.meta.url).pathname;
const REPEATER_STATS_FILE = new URL("./repeater-stats.jsonl", import.meta.url).pathname;

const BETTERSTACK_HOST = process.env.BETTERSTACK_HOST ?? "";
const BETTERSTACK_TOKEN = process.env.BETTERSTACK_TOKEN ?? "";
const SR_REPEATER_PASSWORD = process.env.SR_REPEATER_PASSWORD ?? "";

const SEEN_FILE = new URL("./seen.json", import.meta.url).pathname;
const SEEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const PATHX_CACHE_FILE = new URL("./data/pathx-cache.json", import.meta.url).pathname;
const PATHX_CACHE_POLL_MS = 10 * 60_000; // 10 minutes

// ---------------------------------------------------------------------------
// Transient error handling — terse logging for known network hiccups
// ---------------------------------------------------------------------------

const TRANSIENT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETDOWN",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
]);

/** Extract the deepest error code from a (possibly nested) fetch error */
function getTransientCode(err: unknown): string | null {
  if (err && typeof err === "object") {
    const e = err as any;
    // fetch errors nest the real cause under .cause
    if (e.cause) {
      const inner = getTransientCode(e.cause);
      if (inner) return inner;
    }
    // AggregateError — check child errors
    if (Array.isArray(e.errors)) {
      for (const child of e.errors) {
        const inner = getTransientCode(child);
        if (inner) return inner;
      }
    }
    if (typeof e.code === "string" && TRANSIENT_CODES.has(e.code)) return e.code;
  }
  return null;
}

/** Per-poller consecutive error tracking */
const errorRuns: Record<string, { code: string; count: number }> = {};

function logPollError(tag: string, err: unknown): void {
  const code = getTransientCode(err);
  if (code) {
    const run = errorRuns[tag];
    if (run && run.code === code) {
      run.count++;
      // Log every 5th consecutive identical error to avoid flooding
      if (run.count % 5 === 0) {
        console.warn(`[${tag}] still failing: ${code} (${run.count}x in a row)`);
      }
    } else {
      errorRuns[tag] = { code, count: 1 };
      console.warn(`[${tag}] poll error: ${code}`);
    }
  } else {
    // Unknown error — log full details
    delete errorRuns[tag];
    console.error(`[${tag}] poll error:`, err);
  }
}

/** Call on successful poll to reset the error run counter */
function clearPollError(tag: string): void {
  if (errorRuns[tag]) {
    if (errorRuns[tag].count > 1) {
      console.log(`[${tag}] recovered after ${errorRuns[tag].count} consecutive failures`);
    }
    delete errorRuns[tag];
  }
}

// ---------------------------------------------------------------------------
// Seen-ID tracking (persisted to disk)
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, appendFileSync, renameSync } from "fs";

let seen: Record<string, number> = {};

function loadSeen(): void {
  try {
    seen = JSON.parse(readFileSync(SEEN_FILE, "utf-8"));
  } catch {
    seen = {};
  }
}

function saveSeen(): void {
  // Prune entries older than 24h before saving
  const cutoff = Date.now() - SEEN_EXPIRY_MS;
  for (const [id, ts] of Object.entries(seen)) {
    if (ts < cutoff) delete seen[id];
  }
  writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
}

function markSeen(id: string): void {
  seen[id] = Date.now();
}

function isSeen(id: string): boolean {
  return id in seen;
}

// ---------------------------------------------------------------------------
// Remote Terminal API helper
// ---------------------------------------------------------------------------

async function sendChannelMessage(channelKey: string, text: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/messages/channel`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel_key: channelKey, text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  console.log(`  -> sent to channel ${channelKey}`);
}

async function postAlert(primaryChannel: string, msg: string): Promise<void> {
  await sendChannelMessage(primaryChannel, msg);
  await sendChannelMessage(CHANNELS.alert, msg);
}

// ---------------------------------------------------------------------------
// USGS Earthquakes
// ---------------------------------------------------------------------------

async function pollQuakes(): Promise<void> {
  try {
    const url = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`USGS ${res.status}`);
    const data = await res.json();

    const features: any[] = data.features ?? [];
    let newCount = 0;

    for (const f of features) {
      const { mag, place, time } = f.properties;
      const [lon, lat, depthKm] = f.geometry.coordinates;

      // Filter: bounding box + minimum magnitude
      if (lat < QUAKE_BBOX.minLat || lat > QUAKE_BBOX.maxLat) continue;
      if (lon < QUAKE_BBOX.minLon || lon > QUAKE_BBOX.maxLon) continue;
      if (mag < QUAKE_MIN_MAG) continue;

      if (isSeen(f.id)) continue;
      markSeen(f.id);
      newCount++;

      const pacificTime = new Date(time).toLocaleTimeString("en-US", {
        hour: "2-digit", minute: "2-digit", hour12: false,
        timeZone: "America/Los_Angeles",
      });
      const depth = depthKm.toFixed(0);
      const msg = `🌋 ${pacificTime}: M${mag.toFixed(1)} ${place}, ${depth} km deep`;
      console.log(`[quake] ${msg}`);
      await postAlert(CHANNELS.quake, msg);
      logAlert("earthquake", { mag, place, lat, lon, depth_km: depthKm, usgs_id: f.id });
    }

    if (newCount === 0) {
      console.log(`[quake] poll ok — no new events (${features.length} in feed)`);
    }
    clearPollError("quake");
    saveSeen();
  } catch (err) {
    logPollError("quake", err);
  }
}

// ---------------------------------------------------------------------------
// NWS Weather Alerts
// ---------------------------------------------------------------------------

// Rate-limit: last time we posted each NWS event type
const weatherCooldowns: Record<string, number> = {};

/** Extract HAZARD line from NWS structured description, e.g. "Wind gusts up to 40 mph and pea size hail" */
function parseHazard(desc: string | undefined): string | null {
  if (!desc) return null;
  const m = desc.match(/HAZARD\.\.\.(.+?)(?:\n|$)/);
  return m ? m[1].trim().replace(/\.$/, "") : null;
}

/** Extract location/movement from NWS description, e.g. "near Half Moon Bay, moving NE at 35 mph" */
function parseLocation(desc: string | undefined): string | null {
  if (!desc) return null;
  // Match "tracking ... near <location>" or "tracking ... over <location>" (may span newlines)
  const flat = desc.replace(/\n/g, " ");
  const loc = flat.match(/tracking [\w ]+?(?:near|over) (.+?),/i);
  const mov = flat.match(/moving (\w+) at (\d+ mph)/i);
  const parts: string[] = [];
  if (loc) parts.push(loc[1].trim());
  if (mov) parts.push(`${mov[1]} ${mov[2]}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Build a terse weather alert message that fits MeshCore limits */
function formatWeatherAlert(event: string, severity: string, areaDesc: string, description: string | undefined, status: string): string {
  const hazard = parseHazard(description);
  const location = parseLocation(description);
  // Non-real alerts (Test/Exercise/Draft/System) get a leading label so users don't panic.
  const prefix = status === "Actual" ? "⚠️" : `[${status.toUpperCase()}]`;

  if (hazard) {
    // Compact event name for common verbose types
    const shortEvent = event === "Special Weather Statement" ? "Spc Wx Stmt"
      : event === "Severe Thunderstorm Warning" ? "Svr T-Storm Warn"
      : event;
    const detail = location ? `${hazard} — ${location}` : hazard;
    return truncate(`${prefix} ${shortEvent}: ${detail}`, 140);
  }

  // Fallback: original format
  const area = truncate(areaDesc, 60);
  return `${prefix} ${event} — ${area} (${severity})`;
}

async function pollWeather(): Promise<void> {
  try {
    const url = `https://api.weather.gov/alerts/active?zone=${NWS_ZONES}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "blorkobot/1.0 meshcore-bot",
        Accept: "application/geo+json",
      },
    });
    if (!res.ok) throw new Error(`NWS ${res.status}`);
    const data = await res.json();

    const features: any[] = data.features ?? [];
    let newCount = 0;

    for (const f of features) {
      const { event, severity, areaDesc, expires, status, messageType, description } = f.properties;

      // Per CAP: status is one of Actual/Exercise/System/Test/Draft; cancellations come via
      // messageType. Non-Actual alerts get a "[TEST]"/"[EXERCISE]"/etc. label in formatWeatherAlert.
      if (messageType === "Cancel") continue;
      if (expires && new Date(expires).getTime() < Date.now()) continue;

      if (isSeen(f.id)) continue;
      markSeen(f.id);
      newCount++;

      // Rate-limit: suppress same event type within cooldown (unless high severity)
      const now = Date.now();
      if (!NWS_HIGH_SEVERITY.has(severity) && weatherCooldowns[event] && now - weatherCooldowns[event] < NWS_COOLDOWN_MS) {
        console.log(`[weather] suppressed (cooldown): ${event} — ${truncate(areaDesc, 40)}`);
        logAlert("weather", { event, severity, area: areaDesc, nws_id: f.id, suppressed: true });
        continue;
      }
      weatherCooldowns[event] = now;

      const msg = formatWeatherAlert(event, severity, areaDesc, description, status);
      console.log(`[weather] ${msg}`);
      await postAlert(CHANNELS.weather, msg);
      logAlert("weather", { event, severity, area: areaDesc, nws_id: f.id });
    }

    if (newCount === 0) {
      console.log(`[weather] poll ok — no new alerts (${features.length} active)`);
    }
    clearPollError("weather");
    saveSeen();
  } catch (err) {
    logPollError("weather", err);
  }
}

// ---------------------------------------------------------------------------
// CAL FIRE Wildfires
// ---------------------------------------------------------------------------

// Track last-known acres/containment so we can post updates on significant changes
const fireState: Record<string, { acres: number; pct: number }> = {};

async function pollFires(): Promise<void> {
  try {
    const url = "https://incidents.fire.ca.gov/umbraco/api/IncidentApi/GeoJsonList?inactive=false";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CAL FIRE ${res.status}`);
    const data = await res.json();

    const features: any[] = data.features ?? [];
    let newCount = 0;

    for (const f of features) {
      const p = f.properties;
      if (!p.IsActive || p.Type !== "Wildfire") continue;

      const id = p.UniqueId;
      const acres = Math.round(p.AcresBurned ?? 0);
      const pct = Math.round(p.PercentContained ?? 0);
      const prev = fireState[id];

      // Skip if we've seen it and nothing significant changed
      // Significant = 20%+ acre growth or 25%+ containment jump
      if (prev) {
        const acreGrowth = acres > 0 && prev.acres > 0
          ? (acres - prev.acres) / prev.acres
          : 0;
        const pctJump = pct - prev.pct;
        if (acreGrowth < 0.2 && pctJump < 25) continue;
      }

      // Also skip if we already posted this exact ID before (first-time dedup)
      if (!prev && isSeen(id)) continue;

      markSeen(id);
      fireState[id] = { acres, pct };
      newCount++;

      const name = p.Name ?? "Unknown";
      const county = p.County ?? "?";
      const msg = `🔥 ${name} (${county}) ${acres}ac ${pct}% contained`;
      console.log(`[fire] ${msg}`);
      await postAlert(CHANNELS.fire, msg);
      logAlert("fire", { name, county, acres, pct_contained: pct, calfire_id: id });
    }

    if (newCount === 0) {
      console.log(`[fire] poll ok — no new/updated fires (${features.length} in feed)`);
    }
    clearPollError("fire");
    saveSeen();
  } catch (err) {
    logPollError("fire", err);
  }
}

// ---------------------------------------------------------------------------
// Space Events (Solar Flares + Geomagnetic Storms)
// ---------------------------------------------------------------------------

let lastKpAlerted = 0; // Track last Kp value we alerted on

async function pollSpaceEvents(): Promise<void> {
  // Solar flares — alert on M-class and above
  try {
    const res = await fetch(
      "https://services.swpc.noaa.gov/json/goes/primary/xray-flares-latest.json",
    );
    if (!res.ok) throw new Error(`SWPC flares ${res.status}`);
    const data: any[] = await res.json();

    for (const f of data) {
      const cls = f.max_class;
      if (!cls) continue;
      // Only M-class and above (M1.0+, X1.0+)
      if (!cls.startsWith("M") && !cls.startsWith("X")) continue;

      const id = `flare-${f.begin_time}`;
      if (isSeen(id)) continue;
      markSeen(id);

      const begin = (f.begin_time || "").slice(0, 16).replace("T", " ");
      const msg = `☀️ ${cls} solar flare at ${begin}Z`;
      console.log(`[space] ${msg}`);
      await postAlert(CHANNELS.space, msg);
      logAlert("solar_flare", { class: cls, begin_time: f.begin_time });
    }
    clearPollError("space-flares");
  } catch (err) {
    logPollError("space-flares", err);
  }

  // Geomagnetic storms — alert on Kp >= 5
  try {
    const res = await fetch(
      "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json",
    );
    if (!res.ok) throw new Error(`SWPC Kp ${res.status}`);
    const data: any[] = await res.json();

    if (data.length < 2) return; // First row is header
    const latest = data[data.length - 1];
    const kp = parseFloat(latest[1]);

    if (kp >= 5 && kp > lastKpAlerted) {
      lastKpAlerted = kp;
      const level =
        kp >= 9 ? "G5-Extreme" :
        kp >= 8 ? "G4-Severe" :
        kp >= 7 ? "G3-Strong" :
        kp >= 6 ? "G2-Moderate" :
        "G1-Minor";
      const msg = `🌌 Geomagnetic storm: Kp ${kp} (${level})`;
      console.log(`[space] ${msg}`);
      await postAlert(CHANNELS.space, msg);
      logAlert("geomagnetic_storm", { kp, level });
    } else if (kp < 5) {
      lastKpAlerted = 0; // Reset when storm subsides
    }
    clearPollError("space-kp");
  } catch (err) {
    logPollError("space-kp", err);
  }

  saveSeen();
}

// ---------------------------------------------------------------------------
// Power Outages (PG&E)
// ---------------------------------------------------------------------------

async function reverseGeocodeCity(x?: number, y?: number): Promise<string> {
  if (x == null || y == null) return "";
  try {
    const lon = (x / 20037508.34) * 180;
    const lat =
      (Math.atan(Math.exp((y / 20037508.34) * Math.PI)) * 360) / Math.PI - 90;
    const url =
      `https://nominatim.openstreetmap.org/reverse` +
      `?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&format=json&zoom=10`;
    const res = await fetch(url, {
      headers: { "User-Agent": "BlorkoBot/1.0" },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return "";
    const data = await res.json();
    const addr = data.address ?? {};
    return addr.city || addr.town || addr.village || "";
  } catch {
    return "";
  }
}

async function pollPowerOutages(): Promise<void> {
  try {
    // Bay Area bounding box in Web Mercator (EPSG:3857)
    const bbox = encodeURIComponent(
      '{"xmin":-13692298,"ymin":4439107,"xmax":-13525308,"ymax":4657278}',
    );
    const url =
      `https://ags.pge.esriemcs.com/arcgis/rest/services/43/outages/MapServer/4/query` +
      `?where=1%3D1&outFields=OUTAGE_ID,EST_CUSTOMERS,OUTAGE_CAUSE` +
      `&geometry=${bbox}&geometryType=esriGeometryEnvelope` +
      `&inSR=3857&spatialRel=esriSpatialRelIntersects&returnGeometry=true&f=json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`PGE ESRI ${res.status}`);
    const data = await res.json();

    const features: any[] = data.features ?? [];
    let newCount = 0;

    for (const f of features) {
      const attrs = f.attributes ?? {};
      const id = `pge-${attrs.OUTAGE_ID ?? ""}`;
      if (!id || id === "pge-" || isSeen(id)) continue;
      markSeen(id);
      newCount++;

      const cust = attrs.EST_CUSTOMERS ?? 0;
      if (cust < POWER_MIN_CUSTOMERS) {
        console.log(`[power] skip outage ${attrs.OUTAGE_ID}: ${cust} customers < ${POWER_MIN_CUSTOMERS}`);
        continue;
      }
      const cause = attrs.OUTAGE_CAUSE ?? "";
      const geo = f.geometry ?? {};
      const city = await reverseGeocodeCity(geo.x, geo.y);
      if (!city) {
        console.log(`[power] skip outage ${attrs.OUTAGE_ID}: unknown location`);
        continue;
      }
      const loc = city;
      const msg = cause
        ? `⚡ PG&E outage: ~${cust} in ${loc} (${cause.toLowerCase()})`
        : `⚡ PG&E outage: ~${cust} in ${loc}`;
      console.log(`[power] ${msg}`);
      await postAlert(CHANNELS.power, msg);
      logAlert("power_outage", {
        utility: "PGE",
        customers: cust,
        cause,
        location: loc,
        outage_id: attrs.OUTAGE_ID,
      });
    }

    if (newCount === 0) {
      console.log(`[power] poll ok — no new outages (${features.length} active in Bay Area)`);
    }
    clearPollError("power");
    saveSeen();
  } catch (err) {
    logPollError("power", err);
  }
}

// ---------------------------------------------------------------------------
// Bay Area MeshCore RSS Feed
// ---------------------------------------------------------------------------

async function pollRSS(): Promise<void> {
  try {
    const res = await fetch(RSS_URL);
    if (!res.ok) throw new Error(`RSS ${res.status}`);
    const xml = await res.text();

    // Parse <item> blocks from RSS XML
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
    let newCount = 0;

    for (const match of items) {
      const block = match[1];
      const guid = block.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1] ?? "";
      const title =
        block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ??
        block.match(/<title>(.*?)<\/title>/)?.[1] ??
        "";
      const link = block.match(/<link>(.*?)<\/link>/)?.[1] ?? "";
      if (!guid || !title) continue;

      const id = `rss-${guid}`;
      if (isSeen(id)) continue;
      markSeen(id);
      newCount++;

      const msg = truncate(`📰 BAMC: ${title} ${link}`, 200);
      console.log(`[rss] ${msg}`);
      await sendChannelMessage(CHANNELS.alert, msg);
      await sendChannelMessage(CHANNELS.bot, msg);
      logAlert("rss", { title, link, guid });
    }

    if (newCount === 0) {
      console.log(`[rss] poll ok — no new posts (${items.length} in feed)`);
    }
    clearPollError("rss");
    saveSeen();
  } catch (err) {
    logPollError("rss", err);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + "…";
}

// ---------------------------------------------------------------------------
// BetterStack logging
// ---------------------------------------------------------------------------

async function sendToBetterStack(
  data: Record<string, unknown> | Record<string, unknown>[],
): Promise<void> {
  if (!BETTERSTACK_TOKEN || !BETTERSTACK_HOST) return;
  try {
    const res = await fetch(`https://${BETTERSTACK_HOST}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BETTERSTACK_TOKEN}`,
      },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`  [betterstack] ${res.status}: ${body}`);
    }
  } catch (err) {
    console.error("[betterstack] send error:", err);
  }
}

// ---------------------------------------------------------------------------
// Stats collection (every 6h)
// ---------------------------------------------------------------------------

async function collectStats(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/statistics`);
    if (!res.ok) throw new Error(`statistics ${res.status}`);
    const data = await res.json();

    // Strip bulky noise_floor samples — keep only the summary fields
    if (data.noise_floor_24h) {
      delete data.noise_floor_24h.samples;
    }

    const entry = { dt: new Date().toISOString(), type: "mesh_stats", ...data };
    appendFileSync(STATS_FILE, JSON.stringify(entry) + "\n");
    console.log("[stats] saved to", STATS_FILE);

    clearPollError("stats");
    await sendToBetterStack(entry);
  } catch (err) {
    logPollError("stats", err);
  }
}

async function loginToRepeater(): Promise<boolean> {
  try {
    const res = await fetch(
      `${API_BASE}/api/contacts/${SR_REPEATER_KEY}/repeater/login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: SR_REPEATER_PASSWORD }),
      },
    );
    if (!res.ok) {
      console.log(`[repeater] login failed (${res.status})`);
      return false;
    }
    const data = await res.json();
    if (!data.authenticated) {
      console.log(`[repeater] login not confirmed: ${data.message ?? data.status}`);
    }
    // Proceed even if not confirmed — the password may have been accepted
    // but the ACK was lost in transit
    return true;
  } catch (err) {
    logPollError("repeater", err);
    return false;
  }
}

const REPEATER_STATUS_RETRIES = 3;
const REPEATER_RETRY_DELAY_MS = 2000;

async function collectRepeaterStats(): Promise<void> {
  try {
    // Login first — repeater requires auth before responding to status
    if (SR_REPEATER_PASSWORD) {
      const loggedIn = await loginToRepeater();
      if (!loggedIn) return;
      // Give the radio time to settle after login
      await new Promise((r) => setTimeout(r, REPEATER_RETRY_DELAY_MS));
    }

    let res: Response | null = null;
    for (let attempt = 1; attempt <= REPEATER_STATUS_RETRIES; attempt++) {
      res = await fetch(
        `${API_BASE}/api/contacts/${SR_REPEATER_KEY}/repeater/status`,
        { method: "POST" },
      );
      if (res.ok) break;
      const body = await res.text();
      console.log(`[repeater] attempt ${attempt}/${REPEATER_STATUS_RETRIES} failed (${res.status}): ${body}`);
      if (attempt < REPEATER_STATUS_RETRIES) {
        await new Promise((r) => setTimeout(r, REPEATER_RETRY_DELAY_MS));
      }
    }
    if (!res || !res.ok) return;
    const data = await res.json();

    // Strip telemetry_history array if present — keep only current values
    delete data.telemetry_history;

    const entry = {
      dt: new Date().toISOString(),
      type: "repeater_status",
      repeater: "SR Repeater",
      repeater_key: SR_REPEATER_KEY,
      ...data,
    };
    appendFileSync(REPEATER_STATS_FILE, JSON.stringify(entry) + "\n");
    console.log("[repeater] saved to", REPEATER_STATS_FILE);

    clearPollError("repeater");
    await sendToBetterStack(entry);
  } catch (err) {
    logPollError("repeater", err);
  }
}

async function collectRepeaterByteWidthStats(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/contacts/repeaters/advert-paths`);
    if (!res.ok) throw new Error(`advert-paths ${res.status}`);
    const data: any[] = await res.json();

    const counts = { single_byte: 0, double_byte: 0, triple_byte: 0 };

    // Collect unique next_hop values across all paths — each next_hop is a
    // repeater's own address hash, so its length directly reflects that
    // repeater's configured byte width.
    const seen = new Set<string>();
    for (const contact of data) {
      for (const p of contact.paths ?? []) {
        if (!p.next_hop || seen.has(p.next_hop)) continue;
        seen.add(p.next_hop);
        const bytes = p.next_hop.length / 2;
        if (bytes <= 1) counts.single_byte++;
        else if (bytes <= 2) counts.double_byte++;
        else counts.triple_byte++;
      }
    }

    const entry = {
      dt: new Date().toISOString(),
      type: "repeater_byte_widths",
      ...counts,
      total: counts.single_byte + counts.double_byte + counts.triple_byte,
    };
    console.log(`[byte-widths] 1-byte=${counts.single_byte} 2-byte=${counts.double_byte} 3-byte=${counts.triple_byte}`);

    await sendToBetterStack(entry);
  } catch (err) {
    logPollError("byte-widths", err);
  }
}

async function collectAllStats(): Promise<void> {
  await collectStats();
  await collectRepeaterStats();
  await collectRepeaterByteWidthStats();
}

// ---------------------------------------------------------------------------
// Message stream (every 30s — logs all mesh traffic to BetterStack)
// ---------------------------------------------------------------------------

let lastMsgId: number | null = null;

async function pollMessages(): Promise<void> {
  try {
    // On first run, just grab the latest message ID as our cursor
    if (lastMsgId === null) {
      const res = await fetch(`${API_BASE}/api/messages?limit=1`);
      if (!res.ok) throw new Error(`messages ${res.status}`);
      const msgs = await res.json();
      if (msgs.length > 0) lastMsgId = msgs[0].id;
      console.log(`[messages] cursor initialized at id=${lastMsgId}`);
      return;
    }

    const res = await fetch(
      `${API_BASE}/api/messages?after_id=${lastMsgId}&limit=200`,
    );
    if (!res.ok) throw new Error(`messages ${res.status}`);
    const msgs: any[] = await res.json();

    if (msgs.length === 0) return;

    // API returns oldest-first when using after_id
    const entries = msgs.map((m) => ({
      dt: new Date(m.received_at * 1000).toISOString(),
      type: "mesh_message",
      msg_type: m.type, // PRIV or CHAN
      msg_id: m.id,
      text: m.text,
      sender_name: m.sender_name,
      sender_key: m.sender_key,
      channel_name: m.channel_name,
      conversation_key: m.conversation_key,
      outgoing: m.outgoing,
      paths: m.paths,
    }));

    // Update cursor to latest
    lastMsgId = Math.max(...msgs.map((m: any) => m.id));
    console.log(`[messages] ${msgs.length} new (cursor now id=${lastMsgId})`);

    clearPollError("messages");
    await sendToBetterStack(entries);
  } catch (err) {
    logPollError("messages", err);
  }
}

// ---------------------------------------------------------------------------
// Daily radio reboot (Heltec + companion at 4am)
// ---------------------------------------------------------------------------

async function rebootRadio(label: string, baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/radio/reboot`, { method: "POST" });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${label} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function dailyReboot(): Promise<void> {
  for (const [label, base] of [
    ["heltec", API_BASE],
    ["companion", COMPANION_API_BASE],
  ] as const) {
    try {
      console.log(`[reboot] rebooting ${label} (${base})`);
      await rebootRadio(label, base);
      console.log(`[reboot] ${label} reboot requested ok`);
    } catch (err) {
      console.error(`[reboot] ${label} failed:`, err);
    }
  }
}

function msUntilNext(hour: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

function scheduleDailyReboot(): void {
  const ms = msUntilNext(DAILY_REBOOT_HOUR);
  const next = new Date(Date.now() + ms);
  console.log(`[reboot] next daily reboot at ${next.toLocaleString()} (in ${(ms / 3600_000).toFixed(2)}h)`);
  setTimeout(() => {
    dailyReboot();
    setInterval(dailyReboot, 24 * 60 * 60 * 1000);
  }, ms);
}

// ---------------------------------------------------------------------------
// Pathx cache — precomputed disambiguation data for !pathx in bot.py
// ---------------------------------------------------------------------------

type PathxCandidate = {
  pubkey: string;
  name: string;
  lat: number;
  lon: number;
  last_seen: number;
};

async function buildPathxCache(): Promise<void> {
  try {
    const [contactsR, advertsR, configR] = await Promise.all([
      fetch(`${API_BASE}/api/contacts?limit=1000`),
      fetch(`${API_BASE}/api/contacts/repeaters/advert-paths`),
      fetch(`${API_BASE}/api/radio/config`),
    ]);
    if (!contactsR.ok || !advertsR.ok || !configR.ok) {
      throw new Error(`http ${contactsR.status}/${advertsR.status}/${configR.status}`);
    }
    const contacts = (await contactsR.json()) as any[];
    const adverts = (await advertsR.json()) as any[];
    const config = (await configR.json()) as any;

    const repeaters = contacts.filter((c) => c.type === 2);
    const selfPubkey = String(config.public_key || "").toLowerCase();

    const prefixes: Record<string, PathxCandidate[]> = {};
    for (const r of repeaters) {
      const pk = String(r.public_key || "").toLowerCase();
      if (pk.length < 2) continue;
      const prefix = pk.slice(0, 2);
      (prefixes[prefix] ??= []).push({
        pubkey: pk,
        name: r.name || "?",
        lat: typeof r.lat === "number" ? r.lat : 0,
        lon: typeof r.lon === "number" ? r.lon : 0,
        last_seen: r.last_seen || 0,
      });
    }

    // Confirmed adjacency graph: adj[A][B] = decayed weight (symmetric). An edge
    // is recorded only when BOTH endpoints are fully known — the originator
    // (always known), BlorkoBot (the advert's terminal listener), or any hop
    // whose prefix matches a single repeater. Weights apply a 7-day half-life
    // (matching CoreScope) so stale neighbors don't pollute scores.
    const adj: Record<string, Record<string, number>> = {};
    const nowS = Math.floor(Date.now() / 1000);
    const HALF_LIFE_S = 7 * 86400;
    const TAU = HALF_LIFE_S / Math.LN2;
    const addEdge = (a: string, b: string, w: number) => {
      if (!a || !b || a === b || w <= 0) return;
      ((adj[a] ??= {})[b] = (adj[a][b] || 0) + w);
      ((adj[b] ??= {})[a] = (adj[b][a] || 0) + w);
    };

    for (const entry of adverts) {
      try {
        const origin = String(entry.public_key || "").toLowerCase();
        if (!origin) continue;
        for (const p of entry.paths || []) {
          const path = String(p.path || "").toLowerCase();
          const len = p.path_len || 0;
          if (!path || !len) continue;
          // Strict divisibility — skip malformed entries rather than fudging the hop width.
          if (path.length % len !== 0) continue;
          const hexPerHop = path.length / len;
          if (hexPerHop !== 2 && hexPerHop !== 4) continue;
          const resolved: (string | null)[] = [];
          for (let i = 0; i + hexPerHop <= path.length; i += hexPerHop) {
            const hopHex = path.slice(i, i + hexPerHop);
            const prefix1 = path.slice(i, i + 2);
            const cands = (prefixes[prefix1] || []).filter((c) =>
              c.pubkey.startsWith(hopHex),
            );
            resolved.push(cands.length === 1 ? cands[0].pubkey : null);
          }
          if (resolved.length === 0) continue;
          const age = Math.max(0, nowS - (p.last_seen || nowS));
          const w = (p.heard_count || 1) * Math.exp(-age / TAU);
          if (resolved[0]) addEdge(origin, resolved[0], w);
          for (let i = 0; i + 1 < resolved.length; i++) {
            if (resolved[i] && resolved[i + 1]) {
              addEdge(resolved[i]!, resolved[i + 1]!, w);
            }
          }
          const last = resolved[resolved.length - 1];
          if (last && selfPubkey) addEdge(last, selfPubkey, w);
        }
      } catch (e) {
        // skip malformed entry; don't kill the whole rebuild
      }
    }

    const cache = {
      updated_at: Math.floor(Date.now() / 1000),
      self: {
        pubkey: selfPubkey,
        lat: typeof config.lat === "number" ? config.lat : 0,
        lon: typeof config.lon === "number" ? config.lon : 0,
      },
      prefixes,
      adj,
    };

    const tmp = `${PATHX_CACHE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache));
    renameSync(tmp, PATHX_CACHE_FILE);
    clearPollError("pathx");
  } catch (err) {
    logPollError("pathx", err);
  }
}

// ---------------------------------------------------------------------------
// Alert event logging (fired inline when alerts are posted)
// ---------------------------------------------------------------------------

function logAlert(
  alertType: string,
  details: Record<string, unknown>,
): void {
  const entry = {
    dt: new Date().toISOString(),
    type: "alert_posted",
    alert_type: alertType,
    ...details,
  };
  sendToBetterStack(entry);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("BlorkoBot alert server starting...");
console.log(`  USGS poll: every ${QUAKE_POLL_MS / 1000}s (M${QUAKE_MIN_MAG}+ in bbox)`);
console.log(`  NWS poll:  every ${NWS_POLL_MS / 1000}s (zones: ${NWS_ZONES})`);
console.log(`  FIRE poll: every ${FIRE_POLL_MS / 1000}s (CAL FIRE active wildfires)`);
console.log(`  Space:    every ${SPACE_POLL_MS / 1000}s (M-class+ flares, Kp 5+ storms)`);
console.log(`  Power:    every ${POWER_POLL_MS / 1000}s (PG&E Bay Area outages)`);
console.log(`  RSS:      every ${RSS_POLL_MS / 1000}s (bayareameshcore.com blog)`);
console.log(`  Stats:     every ${STATS_POLL_MS / 1000 / 3600}h -> ${STATS_FILE}`);
console.log(`  Repeater:  every ${STATS_POLL_MS / 1000 / 3600}h -> ${REPEATER_STATS_FILE}`);
console.log(`  Messages:  every ${MSG_POLL_MS / 1000}s -> BetterStack`);
console.log(`  BetterStack: ${BETTERSTACK_TOKEN ? "enabled" : "disabled (set BETTERSTACK_TOKEN)"}`);

loadSeen();
console.log(`  Loaded ${Object.keys(seen).length} seen IDs from disk`);

// Run immediately, then on interval
pollQuakes();
pollWeather();
pollFires();
pollSpaceEvents();
pollPowerOutages();
pollRSS();
collectAllStats();
pollMessages();
buildPathxCache();

setInterval(pollQuakes, QUAKE_POLL_MS);
setInterval(pollWeather, NWS_POLL_MS);
setInterval(pollFires, FIRE_POLL_MS);
setInterval(pollSpaceEvents, SPACE_POLL_MS);
setInterval(pollPowerOutages, POWER_POLL_MS);
setInterval(pollRSS, RSS_POLL_MS);
setInterval(collectAllStats, STATS_POLL_MS);
setInterval(pollMessages, MSG_POLL_MS);
setInterval(buildPathxCache, PATHX_CACHE_POLL_MS);

scheduleDailyReboot();
