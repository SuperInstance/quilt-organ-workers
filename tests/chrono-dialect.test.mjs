/**
 * tests/chrono-dialect.test.mjs — the watcher's CHRONO dialect (wave-73, 73-h).
 *
 * The derived-projection watch: quilt-chrono's ledger tip joins the notary
 * watch as lane "chrono". The watcher re-derives the tip from the COMMITTED
 * ledger (examples/tide/outputs/ledger.jsonl on GitHub raw) with a law
 * restated here, sharing NO code path with the watched repo:
 *
 *   ENTRY law (chrono loadLedger): 0-based gapless seqs, strictly increasing
 *     ISO ts_utc, op ∈ {read,write}, cause ∈ the ten-entry set.
 *   LINK law (chrono seal.js): hash = sha256(canonical({seq, op, prev})),
 *     genesis prev "GENESIS", tip = last link's hash (bare hex64).
 *
 * Class note (the honest boundary, receipted in receipts/CHRONO-TIP-ANCHOR.md):
 * the committed ledger carries NO carried hashes, so a tampered VALUE
 * re-derives fine with a DIFFERENT tip — a fork signature, caught as
 * ADVANCED divergence against the anchored tip (the notaries' job), NOT as
 * derivation failure. Structural breaks (gap / ts-regress / bad op or cause /
 * unparseable line) DO fail closed with named classes.
 *
 * Fixtures are built with the test's own link-law re-implementation; the
 * cross-law agreement test pins the fixture law against an INDEPENDENT
 * shallow-canonical builder so a canonical() regression cannot self-confirm.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  deriveChronoTip,
  deriveTipForDialect,
  divergenceVerdict,
  LANE_CONFIG,
} from "../src/organ-watcher/divergence.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");

// ---- chrono fixture (the test re-implements seal.js's link law) --------------

// Independent canonical: sort keys at every depth (vs the module's canonical,
// used by the module under test — keeping this separate makes test 1 a real
// cross-check of the canonicalization law, not a tautology).
function deepCanon(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(deepCanon).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + deepCanon(value[k])).join(",") + "}";
}

function chronoLink(seq, entry, prev) {
  return sha(deepCanon({ seq, op: entry, prev }));
}

function buildChronoLedger(entries) {
  let prev = "GENESIS";
  const lines = entries.map((e, i) => {
    prev = chronoLink(i, e, prev);
    return JSON.stringify(e);
  });
  return lines.join("\n") + "\n";
}

const ENTRIES = [
  { seq: 0, ts_utc: "2026-09-21T14:13:20.001Z", op: "write", cell: "sensor.raw", value: 60, by: "engine:init", cause: "init", pushed: false, flow_id: null, edge: null, corrects: null },
  { seq: 1, ts_utc: "2026-09-21T14:13:20.002Z", op: "read", cell: "sensor.raw", value: 60, by: "push:health", cause: "push", pushed: true, flow_id: "flow-1-0", edge: "sensor.raw->health", corrects: null },
  { seq: 2, ts_utc: "2026-09-21T14:13:20.003Z", op: "write", cell: "health", value: 60, by: "sensor.raw", cause: "push", pushed: true, flow_id: "flow-1-0", edge: "sensor.raw->health", corrects: null },
  { seq: 3, ts_utc: "2026-09-21T14:14:00.016Z", op: "read", cell: "health", value: null, by: "agent:watcher", cause: "pull", pushed: false, flow_id: null, edge: null, corrects: null },
];

const ledger4 = buildChronoLedger(ENTRIES);
const tip4 = chronoLink(3, ENTRIES[3], chronoLink(2, ENTRIES[2], chronoLink(1, ENTRIES[1], chronoLink(0, ENTRIES[0], "GENESIS"))));

// ---- derivation ---------------------------------------------------------------

test("deriveChronoTip re-derives the honest ledger tip from GENESIS (cross-law agreement)", async () => {
  const r = await deriveChronoTip(ledger4);
  assert.equal(r.ok, true);
  assert.equal(r.rows, 4);
  assert.equal(r.tip, tip4, "module law must agree with the test's independent link-law builder");
  assert.match(r.tip, /^[a-f0-9]{64}$/);
  // determinism: re-deriving the same ledger yields the same tip
  const again = await deriveChronoTip(ledger4);
  assert.equal(again.tip, r.tip);
});

test("deriveTipForDialect routes 'chrono' (and still refuses unknown dialects)", async () => {
  const r = await deriveTipForDialect("chrono", ledger4);
  assert.equal(r.ok, true);
  assert.equal(r.tip, tip4);
  const bad = await deriveTipForDialect("chrono-plus", ledger4);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /unknown dialect/);
});

test("deriveChronoTip: a tampered VALUE re-derives fine with a DIFFERENT tip (fork, not corruption)", async () => {
  // the committed chrono ledger carries no hashes — the sidecar is derived
  // data — so tamper is the ADVANCED-divergence class against the anchor
  const forged = ledger4.replace('"sensor.raw"', '"sensor.FORGED"');
  const r = await deriveChronoTip(forged);
  assert.equal(r.ok, true, "structural law still holds");
  assert.notEqual(r.tip, tip4, "but the tip moved — the anchor sees this as ADVANCED");
  const v = divergenceVerdict({ history: [{ day: "2026-10-02", tip: tip4 }], current: r });
  assert.equal(v.verdict, "ADVANCED");
  assert.equal(v.divergence, true);
});

test("deriveChronoTip fails CLOSED on a seq gap (LEDGER_GAP class)", async () => {
  const gapped = buildChronoLedger(ENTRIES).replace(/"seq":2/, '"seq":7');
  const r = await deriveChronoTip(gapped);
  assert.equal(r.ok, false);
  assert.match(r.reason, /LEDGER_GAP class/);
});

test("deriveChronoTip fails CLOSED on a time regression (LEDGER_TIME_REGRESS class)", async () => {
  const regressed = buildChronoLedger(ENTRIES).replace(
    '"ts_utc":"2026-09-21T14:13:20.003Z"',
    '"ts_utc":"2026-09-21T14:13:20.0015Z"',
  );
  const r = await deriveChronoTip(regressed);
  assert.equal(r.ok, false);
  assert.match(r.reason, /LEDGER_TIME_REGRESS class/);
});

test("deriveChronoTip fails CLOSED on bad op and bad cause (LEDGER_BAD_ENTRY class)", async () => {
  const badOp = buildChronoLedger(ENTRIES).replace('"op":"read"', '"op":"observe"');
  const rOp = await deriveChronoTip(badOp);
  assert.equal(rOp.ok, false);
  assert.match(rOp.reason, /bad op .*LEDGER_BAD_ENTRY class/);

  const badCause = buildChronoLedger(ENTRIES).replace('"cause":"pull"', '"cause":"vibes"');
  const rCause = await deriveChronoTip(badCause);
  assert.equal(rCause.ok, false);
  assert.match(rCause.reason, /bad cause .*LEDGER_BAD_ENTRY class/);

  const unparseable = ledger4 + "{not json}\n";
  const rJson = await deriveChronoTip(unparseable);
  assert.equal(rJson.ok, false);
  assert.match(rJson.reason, /not valid JSON .*LEDGER_BAD_ENTRY class/);
});

test("deriveChronoTip: empty ledger is honest ok:false, never a guessed tip", async () => {
  const r = await deriveChronoTip("\n\n");
  assert.equal(r.ok, false);
  assert.match(r.reason, /empty/);
});

// ---- registration + the end-to-end watch scenario ------------------------------

test("LANE_CONFIG registers the chrono lane against the COMMITTED ledger path", () => {
  const cfg = LANE_CONFIG.chrono;
  assert.ok(cfg, "the chrono lane must be code-registered");
  assert.equal(cfg.source, "github_raw");
  assert.equal(cfg.repo, "SuperInstance/quilt-chrono");
  assert.equal(cfg.branch, "main");
  assert.equal(cfg.path, "examples/tide/outputs/ledger.jsonl");
  assert.equal(cfg.dialect, "chrono");
});

test("SCENARIO MATCH: anchored chrono tip == current tip after the wave-73 anchor", async () => {
  const current = await deriveChronoTip(ledger4);
  const v = divergenceVerdict({ history: [{ day: "2026-10-02", tip: tip4 }], current });
  assert.equal(v.verdict, "MATCH");
  assert.equal(v.divergence, false);
});

test("SCENARIO TAIL TRUNCATION -> REGRESSED: chrono ledger truncated to an earlier anchored tip", async () => {
  const tip3 = chronoLink(2, ENTRIES[2], chronoLink(1, ENTRIES[1], chronoLink(0, ENTRIES[0], "GENESIS")));
  const history = [
    { day: "2026-10-01", tip: tip3 },
    { day: "2026-10-02", tip: tip4 },
  ];
  const truncatedText = buildChronoLedger(ENTRIES.slice(0, 3));
  const current = await deriveChronoTip(truncatedText);
  assert.equal(current.tip, tip3, "the truncated chain still re-derives — only the anchor sees the regression");
  const v = divergenceVerdict({ history, current });
  assert.equal(v.verdict, "REGRESSED");
  assert.equal(v.divergence, true);
});
