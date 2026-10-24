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

// Daily help/tip reminders at 3pm local (PST/PDT). #test fires at :00,
// #bot fires at :01 — a minute apart so both messages reliably get out.
const DAILY_TIP_HOUR = 15;
const DAILY_TIP_BOT_MINUTE = 1;

// Public channel welcome. This is the ONLY thing we ever send to Public —
// nothing else may post there.
// Text is 105 bytes / 121 with the sender name prepended — over the 120 byte
// mesh limit, so if it gets clipped, trim here first.
const PUBLIC_WELCOME_TEXT =
  "⭐️ Welcome to Bay Area MeshCore! 🌉 See baymc.org for the channel list and join the Discord! ⭐️";

// The welcome only goes out when newcomers are actually around: all three of
// these must hold. Tuned to land ~1-2/day; adjust after watching real traffic.
const WELCOME_MIN_GAP_H = 12; // hours since the last welcome
const WELCOME_MIN_NEW = 3; // new-to-us speakers in Public since the last welcome
const WELCOME_ACTIVE_MIN = 90; // Public must have talked within this many minutes
const WELCOME_CHECK_MS = 10 * 60_000; // re-evaluate every 10 min
const WELCOME_STATE_FILE = new URL("./welcome-state.json", import.meta.url).pathname;

// MeshCore channel keys (hex). Fill in for your own deployment.
const CHANNELS = {
  quake: "",
  weather: "",
  fire: "",
  space: "",
  power: "",
  alert: "",
  bot: "",
  test: "",
  public: "",
  mcmonday: "",
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

// SR telemetry poll times, local hours (server runs US/Pacific)
const SR_TELEMETRY_HOURS = [0, 8, 18]; // midnight, 8am, 6pm
const MSG_POLL_MS = 30_000; // 30s — low-traffic mesh, keep it responsive

// Optional: public key of a repeater whose telemetry we poll. Leave blank to disable.
const SR_REPEATER_KEY = "";

// Daily clock sync for repeaters we administer, at 5:30am local (after the 4am
// radio reboot). Our radio's key must be in each repeater's ACL at admin level.
const CLOCK_SYNC_REPEATERS: { name: string; key: string }[] = [
  // { name: "My Repeater", key: "<64-hex public key>" },
];
const CLOCK_SYNC_HOUR = 5;
const CLOCK_SYNC_MINUTE = 30;
const CLOCK_SYNC_TOLERANCE_S = 120; // don't touch the clock if within ±2 min
const CLOCK_SYNC_RETRY_DELAY_MS = 20_000; // CLI round-trip is slow over lossy RF
const CLOCK_SYNC_CLKREBOOT_WAIT_MS = 90_000; // reboot takes ~1-2 min to come back
const CLOCK_SYNC_CLKREBOOT_REARM_MS = 7 * 24 * 60 * 60 * 1000; // re-allow clkreboot weekly
const CLOCK_SYNC_STATE_FILE = new URL("./clock-sync-state.json", import.meta.url).pathname;

const STATS_FILE = new URL("./stats.jsonl", import.meta.url).pathname;
const REPEATER_STATS_FILE = new URL("./repeater-stats.jsonl", import.meta.url).pathname;
const EVENTS_LOG_FILE = new URL("./logs/events.jsonl", import.meta.url).pathname;
// Trim local logs once they exceed this size, keeping the most recent tail.
// Bounds disk usage forever without logrotate-style external tooling.
// At busy-mesh message volume (~400KB/h) 400MB keeps roughly a month.
const LOG_MAX_BYTES = 1024 * 1024 * 1024; // 1GB per file
const LOG_KEEP_BYTES = 400 * 1024 * 1024; // after trim: keep newest 400MB
const LOG_TRIM_CHECK_BYTES = 16 * 1024 * 1024; // check size every ~16MB of appends

const SR_REPEATER_PASSWORD = process.env.SR_REPEATER_PASSWORD ?? "";
// Home Assistant webhook for SR telemetry (LAN-only); unset = don't push
const HA_WEBHOOK_URL = process.env.HA_WEBHOOK_URL ?? "";

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

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  mkdirSync,
} from "fs";
import { dirname } from "path";
import { spawn } from "child_process";
import { parseVtecs, segmentsFor, formatTsunami } from "./tsunami.ts";

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

      // Same NTWC bulletin pollTsunami reads — this is its fallback, deduped by VTEC
      if (event.startsWith("Tsunami")) {
        for (const seg of segmentsFor(description ?? "", TSUNAMI_ZONES)) await handleTsunamiSegment(seg, "nws-alert");
        continue;
      }

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
// Tsunami — polls the raw NTWC West Coast bulletin (TSUWCA) every 15s
// ---------------------------------------------------------------------------

const TSUNAMI_POLL_MS = 15_000;
const TSUNAMI_ZONES = new Set(NWS_ZONES.split(","));
const TSUNAMI_MAX_AGE_MS = 6 * 60 * 60_000; // ignore stale bulletins on startup
const NWS_HEADERS = { "User-Agent": "blorkobot/1.0 meshcore-bot", Accept: "application/ld+json" };

/** Post each new tsunami level for our zones once per event (VTEC tracking number) */
async function handleTsunamiSegment(seg: string, source: string): Promise<void> {
  const vtecs = parseVtecs(seg).filter((v) => v.cls === "O"); // drops the monthly tests
  // A downgrade carries W CAN + Y NEW together — announce only the new level
  const starts = vtecs.filter((v) => v.action !== "CAN" && v.action !== "EXP");
  const ended = starts.length === 0;
  for (const v of ended ? vtecs : starts) {
    const startKey = `tsunami:${v.etn}:${v.sig}`;
    const key = ended ? `${startKey}:end` : startKey;
    if (isSeen(key) || (ended && !isSeen(startKey))) continue;
    markSeen(key);
    saveSeen();
    const msg = formatTsunami(v.sig, ended, seg);
    console.log(`[tsunami] ${msg}`);
    await postAlert(CHANNELS.weather, msg);
    logAlert("tsunami", { vtec: `${v.action}.${v.sig}.${v.etn}`, source });
  }
}

async function pollTsunami(): Promise<void> {
  try {
    const opts = { headers: NWS_HEADERS, signal: AbortSignal.timeout(10_000) };
    const res = await fetch("https://api.weather.gov/products/types/TSU/locations/WCA", opts);
    if (!res.ok) throw new Error(`NWS TSU ${res.status}`);
    const products: any[] = (await res.json())["@graph"] ?? [];
    // Oldest first so a CAN never lands before the NEW it ends
    for (const p of products.slice(0, 3).reverse()) {
      if (isSeen(`tsuprod:${p.id}`)) continue;
      if (Date.now() - new Date(p.issuanceTime).getTime() > TSUNAMI_MAX_AGE_MS) continue;
      const pr = await fetch(`https://api.weather.gov/products/${p.id}`, { headers: NWS_HEADERS, signal: AbortSignal.timeout(10_000) });
      if (!pr.ok) throw new Error(`NWS product ${pr.status}`);
      const { productText } = await pr.json();
      for (const seg of segmentsFor(productText ?? "", TSUNAMI_ZONES)) await handleTsunamiSegment(seg, "ntwc");
      markSeen(`tsuprod:${p.id}`);
      saveSeen();
    }
    clearPollError("tsunami");
  } catch (err) {
    logPollError("tsunami", err);
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
  const lon = (x / 20037508.34) * 180;
  const lat =
    (Math.atan(Math.exp((y / 20037508.34) * Math.PI)) * 360) / Math.PI - 90;
  return reverseGeocodeLatLon(lat, lon);
}

async function reverseGeocodeLatLon(lat: number, lon: number): Promise<string> {
  try {
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
// Military aircraft (ADS-B, same dbFlags military bit as !mil)
// ---------------------------------------------------------------------------

const MIL_CENTER = { lat: 37.6, lon: -122.3 }; // same as bot.py _BAY_AREA_CENTER
const MIL_RADIUS_NM = 25; // tighter than !mil's 40 to leave out the Travis AFB pattern
const MIL_POLL_MS = 2 * 60_000;
// Not tuned yet: Bay Area military traffic volume is unknown. Check the
// alert_posted "military" rows in logs/events.jsonl and adjust these.
const MIL_MIN_GAP_MS = 30 * 60_000; // at most one alert per 30 min
const MIL_MAX_PER_DAY = 6;
let milLastPost = 0;
let milDay = "";
let milDayCount = 0; // ponytail: in-memory, resets on server restart

async function fetchAdsb(lat: number, lon: number, nm: number): Promise<any[]> {
  try {
    const res = await fetch(`https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`adsb.lol ${res.status}`);
    return (await res.json()).ac ?? [];
  } catch (err) {
    console.log(`[mil] adsb.lol failed, trying adsb.fi: ${err}`);
    const res = await fetch(`https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`adsb.fi ${res.status}`);
    return (await res.json()).aircraft ?? [];
  }
}

async function pollMilitary(): Promise<void> {
  try {
    const aircraft = await fetchAdsb(MIL_CENTER.lat, MIL_CENTER.lon, MIL_RADIUS_NM);
    const mil = aircraft.filter((a) =>
      ((a.dbFlags ?? 0) & 1) && a.lat != null && a.lon != null &&
      typeof a.alt_baro === "number" && a.alt_baro >= 200);
    const day = new Date().toISOString().slice(0, 10);
    if (day !== milDay) { milDay = day; milDayCount = 0; }

    for (const a of mil) {
      const id = `mil-${a.hex}-${day}`; // each airframe at most once per day
      if (isSeen(id)) continue;
      const cs = (a.flight ?? "").trim() || a.r || a.hex;
      if (Date.now() - milLastPost < MIL_MIN_GAP_MS || milDayCount >= MIL_MAX_PER_DAY) {
        console.log(`[mil] held (rate limit): ${cs}`);
        continue; // not marked seen, so it can still post once the gap passes
      }
      markSeen(id);
      const alt = a.alt_baro >= 1000 ? `${Math.round(a.alt_baro / 1000)}kft` : `${a.alt_baro}ft`;
      const city = await reverseGeocodeLatLon(a.lat, a.lon);
      const msg = `✈️ Military: ${[cs, a.t, alt].filter(Boolean).join(" ")} over ${city || "the Bay"}`;
      console.log(`[mil] ${msg}`);
      await sendChannelMessage(CHANNELS.alert, msg);
      milLastPost = Date.now();
      milDayCount++;
      logAlert("military", { callsign: cs, type: a.t, hex: a.hex, alt: a.alt_baro, lat: a.lat, lon: a.lon, city });
    }
    if (!mil.length) console.log(`[mil] poll ok — none airborne (${aircraft.length} aircraft)`);
    clearPollError("mil");
    saveSeen();
  } catch (err) {
    logPollError("mil", err);
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
// Local JSONL event logging (with size trim)
// Every event type (alerts, mesh messages, byte-widths) appends one JSON line
// to logs/events.jsonl. Stats and repeater telemetry keep their own files.
// ---------------------------------------------------------------------------

let logBytesSinceCheck = 0;

/**
 * Trim a JSONL file in place to its newest ~LOG_KEEP_BYTES by re-writing it
 * atomically. Drops the partial first line and old data beyond that point.
 */
function trimLog(file: string): void {
  try {
    const size = statSync(file).size;
    if (size <= LOG_MAX_BYTES) return;
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(LOG_KEEP_BYTES);
      const bytesRead = readSync(fd, buf, 0, LOG_KEEP_BYTES, Math.max(0, size - LOG_KEEP_BYTES));
      const text = buf.subarray(0, bytesRead).toString("utf-8");
      const firstNl = text.indexOf("\n");
      const tail = firstNl >= 0 ? text.slice(firstNl + 1) : text;
      if (!tail) return;
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, tail);
      renameSync(tmp, file);
      console.log(`[log] trimmed ${file} from ${(size / 1e6).toFixed(1)}MB to ${(tail.length / 1e6).toFixed(1)}MB`);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    console.error(`[log] trim failed for ${file}:`, err);
  }
}

/** Append one JSON line; every so often, check whether the file needs trimming. */
function appendEvent(file: string, entry: Record<string, unknown>): void {
  const line = JSON.stringify(entry) + "\n";
  appendFileSync(file, line);
  logBytesSinceCheck += line.length;
  if (logBytesSinceCheck >= LOG_TRIM_CHECK_BYTES) {
    logBytesSinceCheck = 0;
    trimLog(file);
  }
}

function logEvents(entries: Record<string, unknown>[]): void {
  if (entries.length === 0) return;
  mkdirSync(dirname(EVENTS_LOG_FILE), { recursive: true });
  for (const entry of entries) {
    appendEvent(EVENTS_LOG_FILE, entry);
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
    appendEvent(STATS_FILE, entry);
    console.log("[stats] saved to", STATS_FILE);

    clearPollError("stats");
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

/** POST an authenticated repeater endpoint, retrying over the lossy RF link. */
async function fetchRepeaterEndpoint(path: string, tag: string): Promise<any | null> {
  for (let attempt = 1; attempt <= REPEATER_STATUS_RETRIES; attempt++) {
    const res = await fetch(
      `${API_BASE}/api/contacts/${SR_REPEATER_KEY}/repeater/${path}`,
      { method: "POST" },
    );
    if (res.ok) return await res.json();
    const body = await res.text();
    console.log(`[repeater] ${tag} attempt ${attempt}/${REPEATER_STATUS_RETRIES} failed (${res.status}): ${body}`);
    if (attempt < REPEATER_STATUS_RETRIES) {
      await new Promise((r) => setTimeout(r, REPEATER_RETRY_DELAY_MS));
    }
  }
  return null;
}

/** Flatten the LPP sensor list into flat columns for the JSONL row. */
function flattenLppSensors(sensors: any[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sensors ?? []) {
    if (s.type_name === "temperature") out.temperature_c = s.value;
    else if (s.type_name === "voltage") out.lpp_voltage = s.value;
  }
  return out;
}

async function collectRepeaterStats(): Promise<void> {
  try {
    // Login first — repeater requires auth before responding to status
    if (SR_REPEATER_PASSWORD) {
      const loggedIn = await loginToRepeater();
      if (!loggedIn) return;
      // Give the radio time to settle after login
      await new Promise((r) => setTimeout(r, REPEATER_RETRY_DELAY_MS));
    }

    const data = await fetchRepeaterEndpoint("status", "status");
    // Temperature only comes back from LPP telemetry — status doesn't carry it
    const lpp = await fetchRepeaterEndpoint("lpp-telemetry", "lpp");

    // The link drops packets often enough that one half regularly comes back
    // without the other — log whatever we did hear, skip only if both missed
    if (!data && !lpp) return;

    // Strip telemetry_history array if present — keep only current values
    if (data) delete data.telemetry_history;

    const entry = {
      dt: new Date().toISOString(),
      type: "repeater_status",
      repeater: "SR Repeater",
      repeater_key: SR_REPEATER_KEY,
      ...(data ?? {}),
      ...(lpp ? flattenLppSensors(lpp.sensors) : {}),
    };
    appendEvent(REPEATER_STATS_FILE, entry);
    console.log("[repeater] saved to", REPEATER_STATS_FILE);
    if (HA_WEBHOOK_URL) {
      fetch(HA_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry) })
        .then((r) => console.log(`[repeater] HA push ${r.status}`))
        .catch((err) => console.log("[repeater] HA push failed:", err));
    }

    clearPollError("repeater");
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
    logEvents([entry]);
  } catch (err) {
    logPollError("byte-widths", err);
  }
}

async function collectAllStats(): Promise<void> {
  await collectStats();
  await collectRepeaterByteWidthStats();
}

/**
 * SR telemetry runs on its own wall-clock schedule rather than the 6h stats
 * interval, so readings land at comparable times of day (solar panel, so the
 * time of day matters). Re-arms after each run: the gaps are uneven and
 * re-computing from local time keeps it right across DST.
 */
function scheduleRepeaterStats(): void {
  const ms = Math.min(...SR_TELEMETRY_HOURS.map((h) => msUntilNext(h)));
  const next = new Date(Date.now() + ms);
  console.log(`[repeater] next telemetry poll at ${next.toLocaleString()} (in ${(ms / 3600_000).toFixed(2)}h)`);
  setTimeout(() => {
    collectRepeaterStats();
    // Re-arm a minute later so the hour we just fired for is safely past
    setTimeout(scheduleRepeaterStats, 60_000);
  }, ms);
}

// ---------------------------------------------------------------------------
// Daily repeater clock sync (5:30am local)
// ---------------------------------------------------------------------------

/**
 * State per repeater key. `clkrebootAt` guards the disruptive fast-clock
 * recovery (clock reset + reboot): at most once per key per week, so a flaky
 * link can't reboot the repeater every day but a genuinely re-fast clock
 * still self-heals.
 */
type ClockSyncState = Record<string, { clkrebootAt?: number }>;

let clockSyncState: ClockSyncState = {};

function loadClockSyncState(): void {
  try {
    clockSyncState = JSON.parse(readFileSync(CLOCK_SYNC_STATE_FILE, "utf-8"));
  } catch {
    clockSyncState = {};
  }
}

function saveClockSyncState(): void {
  writeFileSync(CLOCK_SYNC_STATE_FILE, JSON.stringify(clockSyncState, null, 2));
}

/**
 * Send a CLI command to a repeater via the RT command endpoint, retrying over
 * the lossy RF link. RT returns HTTP 200 with "(no response...)" when the RF
 * reply is lost — that counts as a miss and gets retried, not accepted.
 * Falls back to the companion radio (admin on both repeaters) if this radio
 * stays silent — e.g. when our own ACL entry lost admin perms and the
 * repeater silently drops our commands (happened to BlorkoBot on one
 * Repeatah, 2026-09-11).
 * Returns [response text or null, the base URL that answered]. Callers should
 * pass back the returned base for subsequent commands in the same exchange,
 * so a companion-routed session isn't reset to the broken path.
 */
async function sendRepeaterCommand(
  key: string,
  command: string,
  tag: string,
  baseUrl: string = API_BASE,
): Promise<[string | null, string]> {
  for (let attempt = 1; attempt <= REPEATER_STATUS_RETRIES; attempt++) {
    let response: string | null = null;
    try {
      const res = await fetch(`${baseUrl}/api/contacts/${key}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
        signal: AbortSignal.timeout(45_000),
      });
      if (res.ok) {
        response = String((await res.json()).response ?? "");
      } else {
        console.log(`[clocksync] ${tag} '${command}' attempt ${attempt}/${REPEATER_STATUS_RETRIES} failed (${res.status})`);
      }
    } catch (err) {
      console.log(`[clocksync] ${tag} '${command}' attempt ${attempt}/${REPEATER_STATUS_RETRIES} error: ${getTransientCode(err) ?? err}`);
    }
    if (isRealResponse(response)) return [response, baseUrl];
    if (attempt < REPEATER_STATUS_RETRIES) {
      await new Promise((r) => setTimeout(r, CLOCK_SYNC_RETRY_DELAY_MS));
    }
  }
  if (baseUrl === API_BASE) {
    console.log(`[clocksync] ${tag}: silent on this radio, trying companion`);
    const [viaCompanion, usedBase] = await sendRepeaterCommand(key, command, tag, COMPANION_API_BASE);
    if (viaCompanion !== null) {
      console.log(`[clocksync] ${tag}: got response via companion radio`);
      return [viaCompanion, usedBase];
    }
  }
  return [null, baseUrl];
}

/** Login to a repeater from the given radio so its CLI session secret is fresh. */
async function repeaterLogin(key: string, baseUrl: string): Promise<void> {
  try {
    await fetch(`${baseUrl}/api/contacts/${key}/repeater/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "" }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    // Login may not have been heard — try the commands anyway; the repeater
    // keeps the session even if the ACK is lost over RF
  }
  await new Promise((r) => setTimeout(r, REPEATER_RETRY_DELAY_MS));
}

/** True when the response text is an actual reply (RT returns this string on silence). */
function isRealResponse(response: string | null): response is string {
  return response !== null && !response.startsWith("(no response");
}

/** Parse "HH:MM - D/M/YYYY UTC" from the firmware `clock` command (day-first). */
function parseClockResponse(response: string): Date | null {
  const m = response.match(/(\d{2}):(\d{2}) - (\d+)\/(\d+)\/(\d+) UTC/);
  if (!m) return null;
  const [, hh, mm, day, month, year] = m;
  // Firmware prints UTC — construct the UTC instant, then read via local methods
  const utc = new Date(Date.UTC(+year, +month - 1, +day, +hh, +mm, 0));
  return isNaN(utc.getTime()) ? null : utc;
}

/**
 * Sync one repeater's clock. MeshCore clocks only move forward:
 * - behind -> `clock sync` sets it from our message timestamp
 * - ahead -> `clkreboot` (reset + reboot), then `clock sync` — disruptive, so
 *   done at most once per repeater per week (guarded in the state file)
 */
async function syncRepeaterClock(r: { name: string; key: string }): Promise<void> {
  const tag = `${r.name} (${r.key.slice(0, 8)})`;
  try {
    // Blank login — we're already in the repeater's ACL at admin level.
    await repeaterLogin(r.key, API_BASE);

    let [response, cmdBase] = await sendRepeaterCommand(r.key, "clock", tag);
    if (!isRealResponse(response)) {
      console.log(`[clocksync] ${tag}: no clock reading, skipping today`);
      logAlert("clock_sync", { repeater: r.name, outcome: "no_reading" });
      return;
    }
    const before = parseClockResponse(response);
    if (!before) {
      console.log(`[clocksync] ${tag}: unparseable clock response '${response}', skipping`);
      logAlert("clock_sync", { repeater: r.name, outcome: "unparseable", response });
      return;
    }
    const deltaS = Math.round((before.getTime() - Date.now()) / 1000);
    console.log(`[clocksync] ${tag}: clock reads ${response} (delta ${deltaS >= 0 ? "+" : ""}${(deltaS / 3600).toFixed(2)}h)`);

    if (Math.abs(deltaS) <= CLOCK_SYNC_TOLERANCE_S) {
      console.log(`[clocksync] ${tag}: within ±${CLOCK_SYNC_TOLERANCE_S}s, done`);
      logAlert("clock_sync", { repeater: r.name, outcome: "in_tolerance", delta_s: deltaS });
      return;
    }

    let outcome: string;

    if (deltaS < 0) {
      // Behind — plain forward sync
      const [syncRes] = await sendRepeaterCommand(r.key, "clock sync", tag, cmdBase);
      outcome = syncRes !== null && syncRes.includes("OK") ? "synced_forward" : "forward_failed";
      console.log(`[clocksync] ${tag}: clock sync -> ${syncRes ?? "no reply"}`);
    } else {
      // Ahead — firmware refuses to move clocks backwards. Only fix: clkreboot
      // (resets clock to 2024 + reboots), then a normal forward sync. The
      // repeater is offline ~1-2 min, so at most once a week per repeater.
      const st = (clockSyncState[r.key] ??= {});
      if (st.clkrebootAt && Date.now() - st.clkrebootAt < CLOCK_SYNC_CLKREBOOT_REARM_MS) {
        console.log(`[clocksync] ${tag}: still ahead but clkreboot done recently; leaving it`);
        logAlert("clock_sync", { repeater: r.name, outcome: "ahead_reboot_recent", delta_s: deltaS });
        return;
      }
      console.log(`[clocksync] ${tag}: clock is fast — sending clkreboot (repeater will reboot)`);
      await sendRepeaterCommand(r.key, "clkreboot", tag, cmdBase);
      st.clkrebootAt = Date.now();
      saveClockSyncState();
      outcome = "clkrebooted";

      // Wait out the reboot before setting the time
      await new Promise((r2) => setTimeout(r2, CLOCK_SYNC_CLKREBOOT_WAIT_MS));

      // Re-login: reboot may have kept us in the ACL, but re-establish anyway
      await repeaterLogin(r.key, cmdBase);

      const [syncRes] = await sendRepeaterCommand(r.key, "clock sync", tag, cmdBase);
      console.log(`[clocksync] ${tag}: post-reboot clock sync -> ${syncRes ?? "no reply"}`);
      if (syncRes !== null && syncRes.includes("OK")) outcome = "clkrebooted_and_synced";
    }

    // Verify with a fresh reading
    [response] = await sendRepeaterCommand(r.key, "clock", tag, cmdBase);
    if (isRealResponse(response)) {
      const after = parseClockResponse(response);
      const afterDelta = after ? Math.round((after.getTime() - Date.now()) / 1000) : null;
      console.log(`[clocksync] ${tag}: now reads ${response} (delta ${afterDelta ?? "?"}s)`);
      logAlert("clock_sync", { repeater: r.name, outcome, delta_before_s: deltaS, delta_after_s: afterDelta });
    } else {
      console.log(`[clocksync] ${tag}: verify read failed (sync may still have worked)`);
      logAlert("clock_sync", { repeater: r.name, outcome, delta_before_s: deltaS, verify: "no_response" });
    }
  } catch (err) {
    console.error(`[clocksync] ${tag}: failed:`, err);
  }
}

async function runClockSync(): Promise<void> {
  for (const r of CLOCK_SYNC_REPEATERS) {
    await syncRepeaterClock(r);
  }
}

// ---------------------------------------------------------------------------
// Message stream (every 30s — logs all mesh traffic to the local events log)
// ---------------------------------------------------------------------------

// Forward cursor. The messages API pages forward with a compound cursor:
// `after` (received_at) + `after_id` (id) must be sent TOGETHER — after_id
// alone is silently ignored, which re-fetched the newest 200 every poll and
// re-logged them (hundreds of duplicate entries per message in events.jsonl).
let lastMsgId: number | null = null;
let lastMsgAt: number | null = null;

async function pollMessages(): Promise<void> {
  try {
    // On first run, just grab the latest message as our cursor
    if (lastMsgId === null) {
      const res = await fetch(`${API_BASE}/api/messages?limit=1`);
      if (!res.ok) throw new Error(`messages ${res.status}`);
      const msgs = await res.json();
      if (msgs.length > 0) {
        lastMsgId = msgs[0].id;
        lastMsgAt = msgs[0].received_at;
      }
      console.log(`[messages] cursor initialized at id=${lastMsgId}`);
      return;
    }

    const res = await fetch(
      `${API_BASE}/api/messages?after=${lastMsgAt ?? 0}&after_id=${lastMsgId}&limit=200`,
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

    // Update cursor: with the compound cursor the response is ordered
    // received_at ASC, id ASC, so the last row is the newest by both keys.
    const last = msgs[msgs.length - 1];
    lastMsgId = last.id;
    lastMsgAt = last.received_at;
    console.log(`[messages] ${msgs.length} new (cursor now id=${lastMsgId})`);

    clearPollError("messages");
    logEvents(entries);
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

function msUntilNext(hour: number, minute: number = 0): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
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
// Daily reminders — 3pm local: fixed reminder to #test, rotating tip to #bot
// ---------------------------------------------------------------------------

const TEST_REMINDER =
  "📣 reminder: use !pathx for extended path, !patha for all paths, !help for more";

const BOT_TIPS: string[] = [
  "!pathx shows your extended path with per-hop distance",
  "!patha lists all known paths to you, not just the active one",
  "!ping replies with SNR & path so you can check signal quality",
  '!w <loc> gives current weather. Try !w 95110 or !w "san jose"',
  "!quake shows recent earthquakes nearby. !quake 4 for M4+ only",
  "!channels lists the most popular hashtag channels on the mesh",
  "!alerts shows active NWS weather alerts in your state",
  "!fire shows recent CAL FIRE incidents nearby",
  "!power checks PG&E outages near you",
  "!space shows recent space weather events (solar flares, etc)",
  "!sun gives sunrise/sunset times for your location",
  "!tide shows tide times for nearby NOAA stations",
  "!stats shows mesh health metrics for the last 24h",
  "!ai <question> asks an AI a quick question",
  "!stock <symbol> shows the latest stock price",
  "!sky <loc> shows interesting aircraft overhead",
  "!blimp <loc> finds blimps & airships near you",
  "!tfr shows active FAA temporary flight restrictions",
  "!haiku <subject> writes you a haiku",
  "!trivia starts a trivia question — first correct answer wins",
  "!8ball asks the magic 8-ball a question",
  "!joke tells a joke",
  "!dadjoke serves up a dad joke",
  "!riddle gives you a riddle to solve",
  "!catfact shares a random cat fact",
];

function dayOfYear(d = new Date()): number {
  const start = new Date(d.getFullYear(), 0, 0);
  const diff = d.getTime() - start.getTime();
  return Math.floor(diff / 86_400_000);
}

async function postTestReminder(): Promise<void> {
  console.log("[reminders] posting #test reminder");
  try {
    await sendChannelMessage(CHANNELS.test, TEST_REMINDER);
  } catch (err) {
    console.error("[reminders] #test failed:", err);
  }
}

async function postBotTip(): Promise<void> {
  const idx = dayOfYear() % BOT_TIPS.length;
  console.log(`[reminders] posting #bot tip (idx ${idx})`);
  try {
    await sendChannelMessage(CHANNELS.bot, `📣 tip: ${BOT_TIPS[idx]}`);
  } catch (err) {
    console.error("[reminders] #bot failed:", err);
  }
}

function scheduleDaily(label: string, hour: number, minute: number, fn: () => Promise<void>): void {
  const ms = msUntilNext(hour, minute);
  const next = new Date(Date.now() + ms);
  console.log(`[reminders] next ${label} at ${next.toLocaleString()} (in ${(ms / 3600_000).toFixed(2)}h)`);
  setTimeout(() => {
    fn();
    setInterval(fn, 24 * 60 * 60 * 1000);
  }, ms);
}

function scheduleDailyReminders(): void {
  scheduleDaily("#test reminder", DAILY_TIP_HOUR, 0, postTestReminder);
  scheduleDaily("#bot tip", DAILY_TIP_HOUR, DAILY_TIP_BOT_MINUTE, postBotTip);
  scheduleDaily("#mcmonday recap (Tue only)", 9, 0, postMcmondaySummary);
}

// Run a bot.py expression inside the RT container (same env + /app/data as the
// live fanout) and return its JSON result. `ns` is the bot module's namespace.
function runBotExpr(expr: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const py = `import sys, json; ns = {"__name__": "botjob"}; exec(sys.stdin.read(), ns); print(json.dumps(${expr}))`;
    const p = spawn("docker", ["exec", "-i", "-w", "/app", "meshcore-bot", "python3", "-c", py]);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`exit ${code}: ${err.slice(-300)}`));
      try {
        resolve(JSON.parse(out.trim().split("\n").pop() || "null"));
      } catch (e) {
        reject(e);
      }
    });
    p.stdin.end(readFileSync(new URL("./bot.py", import.meta.url)));
  });
}

// Tuesday-morning recap of Monday's #mcmonday check-ins (same output as !mcmonday).
async function postMcmondaySummary(): Promise<void> {
  if (new Date().getDay() !== 2) return;
  try {
    const msgs: string[] = await runBotExpr(`ns["cmd_mcmonday"](budget=60)`);
    if (!Array.isArray(msgs) || !msgs.length || / 0 check-ins/.test(msgs[0])) {
      console.log("[mcmonday] no check-ins this week, skipping recap");
      return;
    }
    for (const [i, m] of msgs.slice(0, 3).entries()) {
      if (i) await new Promise((r) => setTimeout(r, 10000));
      await sendChannelMessage(CHANNELS.mcmonday, m);
    }
    console.log(`[mcmonday] posted recap (${Math.min(msgs.length, 3)} msgs)`);
  } catch (err) {
    console.error("[mcmonday] recap failed:", err);
  }
}

function scheduleClockSync(): void {
  loadClockSyncState();
  scheduleDaily("repeater clock sync", CLOCK_SYNC_HOUR, CLOCK_SYNC_MINUTE, runClockSync);
}

// ---------------------------------------------------------------------------
// Public channel welcome — only when newcomers show up, nothing else
// ---------------------------------------------------------------------------

type WelcomeState = {
  speakers: Record<string, number>; // pubkey -> unix sec first heard in Public
  newSinceWelcome: number;
  lastWelcomeAt: number; // unix sec
};

let welcomeState: WelcomeState = { speakers: {}, newSinceWelcome: 0, lastWelcomeAt: 0 };

function loadWelcomeState(): void {
  try {
    const s = JSON.parse(readFileSync(WELCOME_STATE_FILE, "utf-8"));
    welcomeState = {
      speakers: s.speakers ?? {},
      newSinceWelcome: s.newSinceWelcome ?? 0,
      lastWelcomeAt: s.lastWelcomeAt ?? 0,
    };
  } catch {
    welcomeState = { speakers: {}, newSinceWelcome: 0, lastWelcomeAt: 0 };
  }
}

function saveWelcomeState(): void {
  writeFileSync(WELCOME_STATE_FILE, JSON.stringify(welcomeState, null, 2));
}

/**
 * Public traffic, newest first. Note: the API's `channel_key` param is silently
 * ignored (it returns every channel) — `conversation_key` is the one that
 * actually filters.
 */
async function fetchPublicMessages(limit = 200): Promise<any[]> {
  const res = await fetch(
    `${API_BASE}/api/messages?conversation_key=${CHANNELS.public}&limit=${limit}`,
  );
  if (!res.ok) throw new Error(`http ${res.status}`);
  return (await res.json()) as any[];
}

// Deepest backlog the API will give us in one shot: 1000 is the hard max (2000
// returns 422) and reaches ~6 days / ~79 speakers. There's no way to page
// further back — `before_id` is silently ignored and just re-returns the head.
// Priming shallow would leave regulars looking new and over-fire the welcome.
const WELCOME_PRIME_LIMIT = 1000;

/** Repeaters (type 2) and room servers (type 3) — chatter from these isn't a newcomer. */
async function fetchNonCompanionKeys(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const c of await fetchAllContacts()) {
    if (c.type !== 1 && c.public_key) out.add(String(c.public_key).toLowerCase());
  }
  return out;
}

/**
 * Fires the welcome only when real newcomers have spoken in Public recently.
 * Adverts deliberately don't count — the mesh is full of bots and repeaters
 * advertising constantly, so speech is the signal that a person is actually there.
 *
 * No cursor: we re-read the last 200 Public messages each pass and dedupe
 * against the persisted speaker set, so a missed poll or restart self-heals.
 */
async function checkPublicWelcome(): Promise<void> {
  try {
    // First ever run: learn who's already here from the full backlog, post nothing.
    const priming = Object.keys(welcomeState.speakers).length === 0;
    const msgs = await fetchPublicMessages(priming ? WELCOME_PRIME_LIMIT : 200);
    // Bots (🤖 in their contact name) aren't newcomers, whatever they say.
    const incoming = msgs.filter(
      (m) => !m.outgoing && m.sender_key && !String(m.sender_name ?? "").includes("🤖"),
    );
    if (incoming.length === 0) return;

    const nonCompanions = await fetchNonCompanionKeys();
    const nowSec = Math.floor(Date.now() / 1000);

    let fresh = 0;
    for (const m of incoming) {
      const key = String(m.sender_key).toLowerCase();
      if (welcomeState.speakers[key]) continue;
      // Contacts we've never adverted count as companions — hearing a message
      // before the advert is normal, and missing a real newcomer is the worse error.
      if (nonCompanions.has(key)) continue;
      welcomeState.speakers[key] = m.received_at ?? nowSec;
      fresh++;
    }

    if (priming) {
      // Start the clock now so we don't post the instant 3 newcomers show up
      welcomeState.lastWelcomeAt = nowSec;
      saveWelcomeState();
      console.log(`[welcome] primed with ${fresh} known Public speakers, nothing sent`);
      return;
    }

    welcomeState.newSinceWelcome += fresh;

    const quietMin = (nowSec - (incoming[0].received_at ?? 0)) / 60;
    const gapH = welcomeState.lastWelcomeAt
      ? (nowSec - welcomeState.lastWelcomeAt) / 3600
      : Infinity;
    const ready =
      gapH >= WELCOME_MIN_GAP_H &&
      welcomeState.newSinceWelcome >= WELCOME_MIN_NEW &&
      quietMin <= WELCOME_ACTIVE_MIN;

    if (!ready) {
      if (fresh > 0) {
        console.log(
          `[welcome] +${fresh} new speaker(s) — ${welcomeState.newSinceWelcome}/${WELCOME_MIN_NEW} new, ` +
            `${gapH === Infinity ? "never sent" : gapH.toFixed(1) + "h gap"}, quiet ${quietMin.toFixed(0)}m`,
        );
      }
      saveWelcomeState();
      return;
    }

    await sendChannelMessage(CHANNELS.public, PUBLIC_WELCOME_TEXT);
    console.log(
      `[welcome] sent — ${welcomeState.newSinceWelcome} new speakers, ${gapH.toFixed(1)}h since last`,
    );
    welcomeState.newSinceWelcome = 0;
    welcomeState.lastWelcomeAt = nowSec;
    saveWelcomeState();
  } catch (err) {
    console.error("[welcome] check failed:", err);
  }
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

const CONTACTS_PAGE = 1000; // RT caps /api/contacts?limit at 1000
const CONTACTS_MAX = 10000; // safety cap so a misbehaving API can't spin forever

async function fetchAllContacts(): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0; offset < CONTACTS_MAX; offset += CONTACTS_PAGE) {
    const res = await fetch(
      `${API_BASE}/api/contacts?limit=${CONTACTS_PAGE}&offset=${offset}`,
    );
    if (!res.ok) throw new Error(`http ${res.status}`);
    const page = (await res.json()) as any[];
    out.push(...page);
    if (page.length < CONTACTS_PAGE) break;
  }
  return out;
}

async function buildPathxCache(): Promise<void> {
  try {
    const [contacts, advertsR, configR] = await Promise.all([
      fetchAllContacts(),
      fetch(`${API_BASE}/api/contacts/repeaters/advert-paths`),
      fetch(`${API_BASE}/api/radio/config`),
    ]);
    if (!advertsR.ok || !configR.ok) {
      throw new Error(`http ${advertsR.status}/${configR.status}`);
    }
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
// Alert event logging (fired inline when alerts are posted; -> events log)
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
  logEvents([entry]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("BlorkoBot alert server starting...");
console.log(`  USGS poll: every ${QUAKE_POLL_MS / 1000}s (M${QUAKE_MIN_MAG}+ in bbox)`);
console.log(`  NWS poll:  every ${NWS_POLL_MS / 1000}s (zones: ${NWS_ZONES})`);
console.log(`  TSU poll:  every ${TSUNAMI_POLL_MS / 1000}s (NTWC TSUWCA)`);
console.log(`  FIRE poll: every ${FIRE_POLL_MS / 1000}s (CAL FIRE active wildfires)`);
console.log(`  Space:    every ${SPACE_POLL_MS / 1000}s (M-class+ flares, Kp 5+ storms)`);
console.log(`  Power:    every ${POWER_POLL_MS / 1000}s (PG&E Bay Area outages)`);
console.log(`  RSS:      every ${RSS_POLL_MS / 1000}s (bayareameshcore.com blog)`);
console.log(`  Stats:     every ${STATS_POLL_MS / 1000 / 3600}h -> ${STATS_FILE}`);
console.log(`  Repeater:  at ${SR_TELEMETRY_HOURS.map((h) => `${h}:00`).join(", ")} local -> ${REPEATER_STATS_FILE}`);
console.log(`  ClockSync: ${CLOCK_SYNC_HOUR}:${String(CLOCK_SYNC_MINUTE).padStart(2, "0")} daily (${CLOCK_SYNC_REPEATERS.map((r) => r.name).join(", ")})`);
console.log(`  Messages:  every ${MSG_POLL_MS / 1000}s -> ${EVENTS_LOG_FILE}`);
console.log(`  Welcome:   every ${WELCOME_CHECK_MS / 60_000}m check -> Public (${WELCOME_MIN_GAP_H}h gap, ${WELCOME_MIN_NEW} new speakers, active <${WELCOME_ACTIVE_MIN}m)`);
console.log(`  Logs:      local, trimmed to ${(LOG_KEEP_BYTES / 1024 / 1024)}MB once ${(LOG_MAX_BYTES / 1024 / 1024)}MB`);

loadSeen();
console.log(`  Loaded ${Object.keys(seen).length} seen IDs from disk`);

// Run immediately, then on interval
pollQuakes();
pollWeather();
pollTsunami();
pollFires();
pollSpaceEvents();
pollPowerOutages();
pollMilitary();
pollRSS();
collectAllStats();
pollMessages();
buildPathxCache();

setInterval(pollQuakes, QUAKE_POLL_MS);
setInterval(pollWeather, NWS_POLL_MS);
setInterval(pollTsunami, TSUNAMI_POLL_MS);
setInterval(pollFires, FIRE_POLL_MS);
setInterval(pollSpaceEvents, SPACE_POLL_MS);
setInterval(pollPowerOutages, POWER_POLL_MS);
setInterval(pollMilitary, MIL_POLL_MS);
setInterval(pollRSS, RSS_POLL_MS);
setInterval(collectAllStats, STATS_POLL_MS);
setInterval(pollMessages, MSG_POLL_MS);
setInterval(buildPathxCache, PATHX_CACHE_POLL_MS);

scheduleDailyReboot();
scheduleDailyReminders();
scheduleRepeaterStats();
scheduleClockSync();

loadWelcomeState();
checkPublicWelcome();
setInterval(checkPublicWelcome, WELCOME_CHECK_MS);
