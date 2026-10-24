/**
 * NTWC tsunami bulletin parsing. The raw bulletin (TSUWCA) is split into
 * segments by "$$"; each starts with a UGC zone list and a VTEC line — the
 * same data the NWS alerts API derives its tsunami alerts from.
 */

export type TsunamiSig = "W" | "Y" | "A"; // Warning / Advisory / Watch

export interface Vtec {
  cls: string; // O = operational, T = test, E/X = experimental
  action: string; // NEW CON EXT EXA EXB UPG CAN EXP COR ROU
  sig: TsunamiSig;
  etn: string; // event tracking number, shared by every bulletin for one event
}

const LEVEL: Record<TsunamiSig, string> = { W: "TSUNAMI WARNING", Y: "Tsunami Advisory", A: "Tsunami Watch" };
const ACTION: Record<TsunamiSig, string> = {
  W: "Move inland to higher ground",
  Y: "Stay off beaches, out of harbors",
  A: "Be ready to act",
};
const MAX_BYTES = 139; // "BlorkoBot 🤖: " + text must fit 155 on air

/** Expand a UGC header ("PZZ530-531-CAZ340>342-300950-") into zone codes */
export function expandUgc(ugc: string): string[] {
  const zones: string[] = [];
  let prefix = "";
  for (const tok of ugc.replace(/\s+/g, "").split("-")) {
    const m = tok.match(/^([A-Z]{2}[ZC])?(\d{3})(?:>(\d{3}))?$/);
    if (!m) continue; // 6-digit expiry time or blank
    if (m[1]) prefix = m[1];
    for (let n = +m[2]; n <= +(m[3] ?? m[2]); n++) zones.push(prefix + String(n).padStart(3, "0"));
  }
  return zones;
}

export function parseVtecs(text: string): Vtec[] {
  return [...text.matchAll(/\/([OTEX])\.([A-Z]{3})\.\w{4}\.TS\.([WYA])\.(\d{4})\./g)]
    .map((m) => ({ cls: m[1], action: m[2], sig: m[3] as TsunamiSig, etn: m[4] }));
}

/** Bulletin segments touching any of our zones */
export function segmentsFor(product: string, zones: Set<string>): string[] {
  return product.split("$$").filter((seg) => {
    const ugc = seg.match(/^[A-Z]{2}[ZC]\d{3}[\d>A-Z\s-]*?\d{6}-/m);
    return ugc && expandUgc(ugc[0]).some((z) => zones.has(z));
  });
}

export function formatTsunami(sig: TsunamiSig, ended: boolean, text: string): string {
  if (ended) return `🌊 ${LEVEL[sig]} for Bay Area coast has ended`;
  const flat = text.replace(/\s+/g, " ");
  const eta = flat.match(/San Francisco California (\d{1,2})(\d{2}) ([AP]M)/);
  const quake = flat.match(/magnitude ([\d.]+) occurred (.+?)\./);
  const parts = [`🌊 ${LEVEL[sig]} for Bay Area coast`, ACTION[sig]];
  if (eta) parts.push(`SF ETA ${eta[1]}:${eta[2]}${eta[3]}`);
  if (quake) parts.push(`M${quake[1]} ${quake[2]}`);
  // Drop trailing detail until it fits rather than cutting mid-word
  while (Buffer.byteLength(parts.join(". ")) > MAX_BYTES) parts.pop();
  return parts.join(". ");
}
