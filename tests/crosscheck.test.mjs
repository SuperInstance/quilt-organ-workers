/**
 * tests/crosscheck.test.mjs — the two-notary cross-check, stdlib-only.
 *
 * The matrix (mission 68-c): per-lane notaries rows {notary, tip, state} and
 * notaryAgreement ∈ BOTH-MATCH / PARTIAL / NO-ANCHORS / NOTARY-DISAGREE
 * (the alarm). Fixtures build BOTH stores with each notary's OWN law:
 *   - our notary rows content-addressed (sha256 of canonical body),
 *   - Mavis's rows HMAC-signed (sig = HMAC-SHA256(token, "chain|tip|seq|at")).
 *
 * Scenarios:
 *   - both anchored, same tip          -> BOTH-MATCH
 *   - both anchored, different tips    -> NOTARY-DISAGREE (divergence, alarm)
 *   - only Mavis anchored              -> PARTIAL
 *   - only ours anchored               -> PARTIAL
 *   - neither anchored                 -> NO-ANCHORS
 *   - Mavis row tampered (sig bad)     -> sig-unverifiable, not a valid
 *                                         witness -> PARTIAL/NO-ANCHORS + flawed
 *   - our row tampered (sha256 bad)    -> corrupt, not a valid witness
 *   - HMAC pinned vector               -> the law matches its own receipt
 *   - full sweep over in-memory KVs    -> rows persisted under
 *                                         watch:_notaries:{lane}, fleet verdict
 *                                         = max severity, NOTHING deleted
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  canonical,
  hmacSha256Hex,
  readNotaryOurs,
  readNotaryMavis,
  agreementVerdict,
  crossCheckSweep,
  loadNotaryRows,
  fleetAgreement,
  normalizeLaneId,
  NOTARY_OURS,
  NOTARY_MAVIS,
} from "../src/organ-watcher/crosscheck.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const TIP_A = "a".repeat(64);
const TIP_B = "b".repeat(64);
const TIP_C = "c".repeat(64);
const TOKEN = "test-notary-key-68c";

// ---- in-memory KV mocks (both namespaces) ------------------------------------

function mockOursKv(rows = {}) {
  // rows: { "anchor:{lane}:{day}": record, "notary-latest:{lane}": day }
  return {
    _m: new Map(Object.entries(rows)),
    async get(key, opts) {
      const v = this._m.has(key) ? this._m.get(key) : null;
      return opts && opts.type === "json" && v != null ? JSON.parse(v) : v;
    },
    async put(key, v) { this._m.set(key, v); },
    async list({ prefix }) {
      return { keys: [...this._m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

/** Build a valid OURS record (content-addressed per tip-notary/logic.mjs law). */
async function oursRecord(lane, day, tip, note) {
  const anchoredAt = `${day}T00:00:00.000Z`; // deterministic; content-addressing needs consistency only
  const body = { lane, day, tip, anchoredAt, prevTipForLane: null, ...(note ? { note } : {}) };
  const record = { ...body, sha256: null };
  record.sha256 = sha(canonical(body));
  return record;
}

/** Build a valid MAVIS row (HMAC-signed per tip-anchor/worker.js law). */
async function mavisRow(chainId, tip, seq, at, note = "", key = TOKEN) {
  const sig = await hmacSha256Hex(key, `${chainId}|${tip}|${seq}|${at}`);
  return { chain_id: chainId, tip, seq, at, note, sig };
}

function mockMavisKv(rows = {}) {
  return {
    _m: new Map(Object.entries(rows)),
    async get(key, opts) {
      const v = this._m.has(key) ? this._m.get(key) : null;
      return opts && opts.type === "json" && v != null ? JSON.parse(v) : v;
    },
    async put(key, v) { this._m.set(key, v); },
    async list({ prefix }) {
      return { keys: [...this._m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

// ---- agreementVerdict matrix (pure) ------------------------------------------

test("BOTH-MATCH: two valid witnesses, same tip", () => {
  const v = agreementVerdict([
    { notary: NOTARY_MAVIS, state: "anchored", tip: TIP_A },
    { notary: NOTARY_OURS, state: "anchored", tip: TIP_A },
  ]);
  assert.equal(v.notaryAgreement, "BOTH-MATCH");
  assert.equal(v.divergence, false);
});

test("NOTARY-DISAGREE: two valid witnesses, different tips — the alarm", () => {
  const v = agreementVerdict([
    { notary: NOTARY_MAVIS, state: "anchored", tip: TIP_A },
    { notary: NOTARY_OURS, state: "anchored", tip: TIP_B },
  ]);
  assert.equal(v.notaryAgreement, "NOTARY-DISAGREE");
  assert.equal(v.divergence, true);
  assert.match(v.reason, /DIFFERENT tips/);
});

test("PARTIAL: only Mavis anchored / only ours anchored", () => {
  const m = agreementVerdict([
    { notary: NOTARY_MAVIS, state: "anchored", tip: TIP_A },
    { notary: NOTARY_OURS, state: "unanchored" },
  ]);
  assert.equal(m.notaryAgreement, "PARTIAL");
  const o = agreementVerdict([
    { notary: NOTARY_MAVIS, state: "unanchored" },
    { notary: NOTARY_OURS, state: "anchored", tip: TIP_C },
  ]);
  assert.equal(o.notaryAgreement, "PARTIAL");
});

test("NO-ANCHORS: neither notary has the lane", () => {
  const v = agreementVerdict([
    { notary: NOTARY_MAVIS, state: "unanchored" },
    { notary: NOTARY_OURS, state: "unanchored" },
  ]);
  assert.equal(v.notaryAgreement, "NO-ANCHORS");
});

test("corrupt witness is NOT a valid anchor: ours corrupt + mavis valid -> PARTIAL with flaw receipted", () => {
  const v = agreementVerdict([
    { notary: NOTARY_MAVIS, state: "anchored", tip: TIP_A },
    { notary: NOTARY_OURS, state: "corrupt", detail: "sha256 re-derivation failed" },
  ]);
  assert.equal(v.notaryAgreement, "PARTIAL");
  assert.match(v.reason, /corrupt/);
});

test("all witnesses flawed -> NO-ANCHORS (no VALID anchor) with flaw named", () => {
  const v = agreementVerdict([
    { notary: NOTARY_MAVIS, state: "sig-unverifiable" },
    { notary: NOTARY_OURS, state: "corrupt" },
  ]);
  assert.equal(v.notaryAgreement, "NO-ANCHORS");
  assert.match(v.reason, /sig-unverifiable/);
  assert.match(v.reason, /corrupt/);
});

// ---- per-notary integrity laws ------------------------------------------------

test("pinned HMAC vector: Mavis's sig law is HMAC-SHA256(token, chain|tip|seq|at)", async () => {
  const msg = "qmr1|aaaa1111bbbb1111cccc1111dddd1111eeee1111ffff1111aaaa1111bbbb1111|5|2026-10-02T17:15:27.360Z";
  assert.equal(await hmacSha256Hex(TOKEN, msg), "8d64123c7c4c5095b190644fd3c5defbd49078e5c8255f1dfc584340c2c23f09");
});

test("readNotaryMavis: valid sig -> anchored; tampered sig -> sig-unverifiable", async () => {
  const row = await mavisRow("qmr1", TIP_A, 5, "2026-10-02T17:15:27.360Z");
  const kv = mockMavisKv({
    "latest:qmr1": "5",
    "anchor:qmr1:5": JSON.stringify(row),
  });
  const okRow = await readNotaryMavis(kv, "qmr1", TOKEN);
  assert.equal(okRow.state, "anchored");
  assert.equal(okRow.tip, TIP_A);
  const tampered = { ...row, tip: TIP_B }; // sig was over TIP_A
  const kv2 = mockMavisKv({ "latest:qmr1": "5", "anchor:qmr1:5": JSON.stringify(tampered) });
  const bad = await readNotaryMavis(kv2, "qmr1", TOKEN);
  assert.equal(bad.state, "sig-unverifiable");
});

test("readNotaryOurs: valid sha256 -> anchored; tampered body -> corrupt", async () => {
  const rec = await oursRecord("qmr1", "2026-10-02", TIP_A);
  const kv = mockOursKv({ "notary-latest:qmr1": "2026-10-02", "anchor:qmr1:2026-10-02": JSON.stringify(rec) });
  const ok = await readNotaryOurs(kv, "qmr1");
  assert.equal(ok.state, "anchored");
  const tampered = { ...rec, tip: TIP_B };
  const kv2 = mockOursKv({ "notary-latest:qmr1": "2026-10-02", "anchor:qmr1:2026-10-02": JSON.stringify(tampered) });
  const bad = await readNotaryOurs(kv2, "qmr1");
  assert.equal(bad.state, "corrupt");
});

test("readNotaryOurs/Mavis: empty store -> unanchored (not an error)", async () => {
  assert.equal((await readNotaryOurs(mockOursKv(), "ghost")).state, "unanchored");
  assert.equal((await readNotaryMavis(mockMavisKv(), "ghost", TOKEN)).state, "unanchored");
});

// ---- the full sweep ------------------------------------------------------------

test("crossCheckSweep over fixture KVs: qmr1 BOTH-MATCH, erised-sequencer:anchor-proof stale-sig -> NO-ANCHORS w/ receipt, fleet verdict max-severity", async () => {
  const day = "2026-10-02";
  const oursKv = mockOursKv();
  const mavisKv = mockMavisKv();

  // qmr1 anchored in BOTH with the same tip -> BOTH-MATCH
  const rec = await oursRecord("qmr1", day, TIP_A, "fixture");
  oursKv._m.set("anchor:qmr1:2026-10-02", JSON.stringify(rec));
  oursKv._m.set("notary-latest:qmr1", day);
  const mrow = await mavisRow("qmr1", TIP_A, 5, "2026-10-02T17:15:27.360Z");
  mavisKv._m.set("anchor:qmr1:5", JSON.stringify(mrow));
  mavisKv._m.set("latest:qmr1", "5");
  mavisKv._m.set("index:qmr1", JSON.stringify({ chain_id: "qmr1", latest_seq: 5, latest_tip: TIP_A }));

  // forked lane anchored in BOTH with DIFFERENT tips -> NOTARY-DISAGREE
  const recD1 = await oursRecord("fork-lane", day, TIP_B);
  oursKv._m.set(`anchor:fork-lane:${day}`, JSON.stringify(recD1));
  oursKv._m.set(`notary-latest:fork-lane`, day);
  const mrowD = await mavisRow("fork-lane", TIP_C, 1, "2026-10-02T09:00:00.000Z");
  mavisKv._m.set(`anchor:fork-lane:1`, JSON.stringify(mrowD));
  mavisKv._m.set(`latest:fork-lane`, "1");
  mavisKv._m.set(`index:fork-lane`, JSON.stringify({ chain_id: "fork-lane", latest_seq: 1, latest_tip: TIP_C }));

  // mavis-only chain whose sig predates the current token -> sig-unverifiable
  const stale = await mavisRow("erised-sequencer:anchor-proof", TIP_B, 2, "2026-10-02T08:07:47.476Z", "wave-66 first external anchor", "the-old-pre-rotation-key");
  mavisKv._m.set("anchor:erised-sequencer:anchor-proof:2", JSON.stringify(stale));
  mavisKv._m.set("latest:erised-sequencer:anchor-proof", "2");
  mavisKv._m.set("index:erised-sequencer:anchor-proof", JSON.stringify({ chain_id: "erised-sequencer:anchor-proof", latest_seq: 2, latest_tip: TIP_B }));

  const env = { ORGANS: oursKv, ANCHORS: mavisKv, WORKER_UPLOAD_TOKEN: TOKEN };
  const result = await crossCheckSweep(env);

  const byLane = new Map(result.lanes.map((r) => [r.lane, r]));
  assert.equal(byLane.get("qmr1").notaryAgreement, "BOTH-MATCH");
  assert.deepEqual(byLane.get("qmr1").notaries.map((n) => n.tip), [TIP_A, TIP_A]);
  assert.equal(byLane.get("fork-lane").notaryAgreement, "NOTARY-DISAGREE");
  assert.equal(byLane.get("fork-lane").divergence, true);
  assert.equal(byLane.get("erised-sequencer:anchor-proof").notaryAgreement, "NO-ANCHORS");
  assert.equal(byLane.get("erised-sequencer:anchor-proof").notaries[0].state, "sig-unverifiable");
  assert.equal(result.notaryAgreement, "NOTARY-DISAGREE"); // max severity
  assert.equal(result.summary.disagreements, 1);
  assert.equal(result.summary.bothMatches, 1);
  assert.equal(result.summary.flawedRows, 1);

  // rows persisted, loadable, and nothing deleted
  // (4 lanes: qmr1, fork-lane, erised-sequencer:anchor-proof, + LANE_CONFIG's
  // erised-ft1 which has no fixture anchors -> NO-ANCHORS, unanchored both)
  const loaded = await loadNotaryRows(oursKv);
  assert.equal(loaded.length, 4);
  assert.equal(byLane.get("erised-ft1").notaryAgreement, "NO-ANCHORS");
  assert.equal(byLane.get("erised-ft1").notaries.every((n) => n.state === "unanchored"), true);
  assert.equal(fleetAgreement(loaded), "NOTARY-DISAGREE");
  assert.ok([...oursKv._m.keys()].every((k) => oursKv._m.has(k))); // nothing vanished
});

test("fleetAgreement severity ordering: disagree > both-match > partial > no-anchors", () => {
  const mk = (lane, a) => ({ lane, notaryAgreement: a });
  assert.equal(fleetAgreement([mk("a", "PARTIAL"), mk("b", "BOTH-MATCH")]), "BOTH-MATCH");
  assert.equal(fleetAgreement([mk("a", "PARTIAL"), mk("b", "NO-ANCHORS")]), "PARTIAL");
  assert.equal(fleetAgreement([mk("a", "NO-ANCHORS")]), "NO-ANCHORS");
  assert.equal(fleetAgreement([]), null);
});

test("canonical poison stays fail-closed in this module too", async () => {
  assert.throws(() => canonical({ bad: undefined }), TypeError);
});

// ---- lane-id normalization across the two namings (wave-69, 69-f) ------------
// Fleet canon carries colons ("erised-sequencer:anchor-proof", receipted in
// receipts/TIP-ANCHOR.md); OUR notary's lane law (LANE_RE) forbids them — so
// the exact-name join could never see a colon-carrying lane dual-witnessed.
// The join key is normalizeLaneId (":" -> "-"); raw spellings stay receipted.

test("normalizeLaneId: colon -> dash is the whole law; plain ids pass through", () => {
  assert.equal(normalizeLaneId("erised-sequencer:anchor-proof"), "erised-sequencer-anchor-proof");
  assert.equal(normalizeLaneId("qmr1"), "qmr1");
  assert.equal(normalizeLaneId("erised-ft1"), "erised-ft1");
  assert.equal(normalizeLaneId("  spaced:out  "), "spaced-out"); // trims, then maps
  assert.equal(normalizeLaneId("a:b:c"), "a-b-c"); // every colon, not just the first
  assert.throws(() => normalizeLaneId(null), TypeError); // fail-closed, never coerced
  assert.throws(() => normalizeLaneId(undefined), TypeError);
});

test("69f join: colon-carrying Mavis chain + dash-spelled ours lane, SAME tip -> one BOTH-MATCH lane, not two PARTIALs", async () => {
  const day = "2026-10-02";
  const oursKv = mockOursKv();
  const mavisKv = mockMavisKv();

  // Mavis holds the colon spelling; our notary (LANE_RE forbids colons) holds
  // the dash spelling — the same lane, witnessed by both, joined by law.
  const mrow = await mavisRow("erised-sequencer:anchor-proof", TIP_A, 3, "2026-10-02T18:20:00.000Z", "69f fixture");
  mavisKv._m.set("anchor:erised-sequencer:anchor-proof:3", JSON.stringify(mrow));
  mavisKv._m.set("latest:erised-sequencer:anchor-proof", "3");
  mavisKv._m.set("index:erised-sequencer:anchor-proof", JSON.stringify({ chain_id: "erised-sequencer:anchor-proof", latest_seq: 3, latest_tip: TIP_A }));
  const rec = await oursRecord("erised-sequencer-anchor-proof", day, TIP_A, "69f fixture");
  oursKv._m.set("anchor:erised-sequencer-anchor-proof:2026-10-02", JSON.stringify(rec));
  oursKv._m.set("notary-latest:erised-sequencer-anchor-proof", day);

  const result = await crossCheckSweep({ ORGANS: oursKv, ANCHORS: mavisKv, WORKER_UPLOAD_TOKEN: TOKEN });

  // ONE merged lane (normalized name, raw spellings receipted) — not two partials
  const merged = result.lanes.filter((r) => r.lane.startsWith("erised-sequencer"));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].lane, "erised-sequencer-anchor-proof");
  assert.equal(merged[0].notaryAgreement, "BOTH-MATCH");
  assert.deepEqual(merged[0].rawIds, {
    [NOTARY_MAVIS]: ["erised-sequencer:anchor-proof"],
    [NOTARY_OURS]: ["erised-sequencer-anchor-proof"],
  });
  assert.deepEqual(merged[0].notaries.map((n) => n.rawId), ["erised-sequencer:anchor-proof", "erised-sequencer-anchor-proof"]);
  assert.equal(result.summary.bothMatches, 1); // one LANE, not two key spellings
  assert.equal(result.summary.partials, 0);

  // persisted under BOTH spellings; the loader dedupes to one row per lane
  assert.ok(oursKv._m.has("watch:_notaries:erised-sequencer-anchor-proof"));
  assert.ok(oursKv._m.has("watch:_notaries:erised-sequencer:anchor-proof"));
  const loaded = await loadNotaryRows(oursKv);
  const erisedRows = loaded.filter((r) => r.lane.startsWith("erised-sequencer"));
  assert.equal(erisedRows.length, 1);
  assert.equal(erisedRows[0].notaryAgreement, "BOTH-MATCH");
  // nothing deleted: every pre-sweep key is still present
  assert.ok([...mavisKv._m.keys()].every((k) => mavisKv._m.has(k)));
});

test("69f join must not hide a fork: same lane under both namings with DIFFERENT tips -> NOTARY-DISAGREE", async () => {
  const day = "2026-10-02";
  const oursKv = mockOursKv();
  const mavisKv = mockMavisKv();

  const mrow = await mavisRow("a:b", TIP_A, 1, "2026-10-02T09:00:00.000Z");
  mavisKv._m.set("anchor:a:b:1", JSON.stringify(mrow));
  mavisKv._m.set("latest:a:b", "1");
  mavisKv._m.set("index:a:b", JSON.stringify({ chain_id: "a:b", latest_seq: 1, latest_tip: TIP_A }));
  const rec = await oursRecord("a-b", day, TIP_C, "fork under the other spelling");
  oursKv._m.set("anchor:a-b:2026-10-02", JSON.stringify(rec));
  oursKv._m.set("notary-latest:a-b", day);

  const result = await crossCheckSweep({ ORGANS: oursKv, ANCHORS: mavisKv, WORKER_UPLOAD_TOKEN: TOKEN });
  const merged = result.lanes.find((r) => r.lane === "a-b");
  assert.equal(merged.notaryAgreement, "NOTARY-DISAGREE");
  assert.equal(merged.divergence, true);
  assert.equal(result.notaryAgreement, "NOTARY-DISAGREE");
});

test("69f supersession: a pre-69f row keyed by the colon spelling is refreshed in place, never duplicated", async () => {
  const day = "2026-10-02";
  const oursKv = mockOursKv();
  const mavisKv = mockMavisKv();

  // yesterday's verdict sitting under the colon key (as the live store has it)
  const staleRow = {
    lane: "erised-sequencer:anchor-proof",
    checkedAt: "2026-10-02T17:23:29.505Z",
    notaries: [{ notary: NOTARY_MAVIS, state: "sig-unverifiable" }, { notary: NOTARY_OURS, state: "unanchored" }],
    notaryAgreement: "NO-ANCHORS",
    divergence: false,
    reason: "no VALID anchor",
  };
  oursKv._m.set("watch:_notaries:erised-sequencer:anchor-proof", JSON.stringify(staleRow));

  // ...and now a valid post-rotation witness lands on Mavis's side only
  const mrow = await mavisRow("erised-sequencer:anchor-proof", TIP_B, 3, "2026-10-02T18:20:00.000Z", "69f fixture");
  mavisKv._m.set("anchor:erised-sequencer:anchor-proof:3", JSON.stringify(mrow));
  mavisKv._m.set("latest:erised-sequencer:anchor-proof", "3");
  mavisKv._m.set("index:erised-sequencer:anchor-proof", JSON.stringify({ chain_id: "erised-sequencer:anchor-proof", latest_seq: 3, latest_tip: TIP_B }));

  await crossCheckSweep({ ORGANS: oursKv, ANCHORS: mavisKv, WORKER_UPLOAD_TOKEN: TOKEN });

  const refreshed = JSON.parse(oursKv._m.get("watch:_notaries:erised-sequencer:anchor-proof"));
  assert.equal(refreshed.notaryAgreement, "PARTIAL"); // superseded in place
  assert.equal(refreshed.lane, "erised-sequencer:anchor-proof"); // single spelling keeps the raw name
  const loaded = await loadNotaryRows(oursKv);
  const erisedRows = loaded.filter((r) => r.lane.startsWith("erised-sequencer"));
  assert.equal(erisedRows.length, 1); // deduped — fleetHealth counts lanes, not spellings
  assert.ok(oursKv._m.has("watch:_notaries:erised-sequencer:anchor-proof")); // nothing vanished
});
