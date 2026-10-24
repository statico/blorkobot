import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { expandUgc, parseVtecs, segmentsFor, formatTsunami } from "./tsunami.ts";

// Real NTWC bulletin from the Jul 2025 Kamchatka M8.8: warning north of Cape
// Mendocino, advisory (incl. SF Bay) from Mexico to Cape Mendocino
const KAMCHATKA = readFileSync(new URL("./test/tsuwca-2025-07-30.txt", import.meta.url), "utf8");
const OURS = new Set(["CAZ006", "CAZ508", "CAZ505", "CAZ529"]);

test("expandUgc handles prefixes, ranges, expiry", () => {
  assert.deepEqual(expandUgc("PZZ530-531-CAZ340>342-006-\n300950-"),
    ["PZZ530", "PZZ531", "CAZ340", "CAZ341", "CAZ342", "CAZ006"]);
});

test("Kamchatka: only the advisory segment is ours", () => {
  const segs = segmentsFor(KAMCHATKA, OURS);
  assert.equal(segs.length, 1);
  assert.deepEqual(parseVtecs(segs[0]), [{ cls: "O", action: "CON", sig: "Y", etn: "0016" }]);
  const msg = formatTsunami("Y", false, segs[0]);
  assert.match(msg, /^🌊 Tsunami Advisory for Bay Area coast\. Stay off beaches, out of harbors\. SF ETA 12:40AM/);
  assert.ok(Buffer.byteLength(msg) <= 139, msg);
});

test("north-coast-only warning is not ours", () => {
  assert.equal(segmentsFor(KAMCHATKA, new Set(["CAZ103"])).length, 1);
  assert.equal(segmentsFor(KAMCHATKA, new Set(["CAZ999"])).length, 0);
});

test("test bulletins are class T", () => {
  assert.equal(parseVtecs("/T.NEW.PAAQ.TS.W.9018.261021T1631Z-261021T1731Z/")[0].cls, "T");
});
