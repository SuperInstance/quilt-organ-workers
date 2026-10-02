/**
 * tests/divergence.test.mjs — the watcher's divergence delta, stdlib-only.
 *
 * Corruption vs divergence, simulated:
 *   corruption  = chain re-derivation FAILS (the existing disease; the organ
 *                 sweep and the dialect derivations here return ok:false)
 *   divergence  = two honest states DISAGREE — the chain re-derives fine but
 *                 its tip is not the anchored tip (the new disease, mission 67-a)
 *
 * Scenarios on a real qmr1-shaped fixture (built with the test's own signer
 * per DESIGN.md §2) and an erised-shaped ledger fixture:
 *   - unmodified store vs latest anchored tip            -> MATCH
 *   - TAIL TRUNCATION (drop rows) back to an anchored tip -> REGRESSED (divergence)
 *   - FORK (rewrite a body value, re-link the chain)      -> ADVANCED  (divergence)
 *   - honest store advanced past the last anchor          -> ADVANCED  (divergence)
 *   - derivable current tip, nothing ever anchored        -> MISSING-ANCHOR (divergence)
 *   - tampered mid-chain body (breaks linkage)            -> ok:false (corruption class)
 *   - tampered ANCHOR record (KV side)                    -> integrity failure (corruption class)
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createHash } from "node:crypto";
import {
  deriveQmr1Tip,
  deriveErisedTip,
  divergenceVerdict,
  canonical,
  sha256hex,
} from "../src/organ-watcher/divergence.mjs";
import { anchorSha256 } from "../src/tip-notary/logic.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");

// ---- qmr1 fixture (the test re-implements DESIGN.md §2 independently) -------

function buildQmr1Store(bodies) {
  let prev = "0".repeat(64);
  const lines = bodies.map((body, i) => {
    const seq = i + 1;
    const id = sha(`qmr1:${seq}:${prev}:${canonical(body)}`);
    const row = { seq, prev, body, id, sig: sha(`sig-of-${id}`) }; // sigs are the organ's custody; the notary anchors the hash chain
    prev = id;
    return JSON.stringify(row);
  });
  return lines.join("\n") + "\n";
}

const BODIES = [
  { kind: "receipt.chain.genesis", ts: "2026-10-01T00:00:00Z" },
  { kind: "engine.run.sealed", ts: "2026-10-01T01:00:00Z", verdict: "ok" },
  { kind: "lesson.minted", ts: "2026-10-01T02:00:00Z", law: "L9" },
  { kind: "scout.report.landed", ts: "2026-10-01T03:00:00Z" },
];

const store4 = buildQmr1Store(BODIES);
const tipOf = async (text) => (await deriveQmr1Tip(text)).tip;
const tip3 = await tipOf(buildQmr1Store(BODIES.slice(0, 3)));
const tip4 = await tipOf(store4);

// ---- erised fixture (re-implements engine.mjs's row law) ---------------------

function buildErisedSession(rows) {
  const ecanon = (o) => JSON.stringify(o, Object.keys(o).sort());
  let prev = "genesis";
  const ops = rows.map(({ op, payload, sticky }, i) => {
    const seq = i + 1;
    const tip = sha(`${seq}|${op}|${ecanon(payload)}|${prev}|${!!sticky}`);
    const row = { seq, op, payload, sticky: !!sticky, prev, tip };
    prev = tip;
    return row;
  });
  return JSON.stringify({ meta: { campaign: "fixture" }, ops, verify: { ok: true, rows: ops.length, tip: prev } });
}

const erised3 = buildErisedSession([
  { op: "init", payload: { name: "divergence drill" } },
  { op: "set", payload: { dial: "hardening", to: 2 }, sticky: true },
  { op: "roll", payload: { solid: "d12", n: 1, why: "table-test the delta" } },
]);

// ---- derivation --------------------------------------------------------------

test("deriveQmr1Tip re-derives the honest store tip from genesis", async () => {
  const r = await deriveQmr1Tip(store4);
  assert.equal(r.ok, true);
  assert.equal(r.rows, 4);
  assert.match(r.tip, /^[a-f0-9]{64}$/);
  // determinism: re-deriving the same store yields the same tip
  assert.equal(r.tip, await tipOf(store4));
});

test("deriveQmr1Tip fails CLOSED with a named-class reason on a tampered body (corruption)", async () => {
  const tampered = buildQmr1Store(BODIES).replace('"ok"', '"FORGED"');
  const r = await deriveQmr1Tip(tampered);
  assert.equal(r.ok, false);
  assert.match(r.reason, /E_HASH_MISMATCH class/);
});

test("deriveErisedTip re-derives the honest ledger tip and cross-checks verify.tip", async () => {
  const r = await deriveErisedTip(erised3);
  assert.equal(r.ok, true);
  assert.equal(r.rows, 3);
  assert.match(r.tip, /^[a-f0-9]{64}$/);
  const session = JSON.parse(erised3);
  assert.equal(r.tip, session.verify.tip);
});

test("deriveErisedTip fails closed on a tampered payload and on a lying verify.tip", async () => {
  const session = JSON.parse(erised3);
  session.ops[2].payload.why = "tampered";
  const r = await deriveErisedTip(JSON.stringify(session));
  assert.equal(r.ok, false);
  assert.match(r.reason, /tip mismatch/);

  const lying = JSON.parse(erised3);
  lying.verify.tip = "f".repeat(64);
  const r2 = await deriveErisedTip(JSON.stringify(lying));
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /verify.tip disagrees/);
});

// ---- verdicts: the divergence simulation -------------------------------------

test("SCENARIO MATCH: unmodified store, latest anchored tip == current tip", async () => {
  const current = await deriveQmr1Tip(store4);
  const v = divergenceVerdict({ history: [{ day: "2026-10-01", tip: tip4 }], current });
  assert.equal(v.verdict, "MATCH");
  assert.equal(v.divergence, false);
});

test("SCENARIO TAIL TRUNCATION -> REGRESSED (divergence): store truncated to an earlier ANCHORED tip", async () => {
  // the fleet anchored tip3 on day one and tip4 on day two; the store then lost row 4
  const history = [
    { day: "2026-10-01", tip: tip3 },
    { day: "2026-10-02", tip: tip4 },
  ];
  const truncated = await deriveQmr1Tip(buildQmr1Store(BODIES.slice(0, 3)));
  assert.equal(truncated.tip, tip3, "the truncated chain still re-derives — corruption detection CANNOT see this");
  const v = divergenceVerdict({ history, current: truncated });
  assert.equal(v.verdict, "REGRESSED");
  assert.equal(v.divergence, true);
  assert.match(v.reason, /BACKWARDS|tail-truncation/);
});

test("SCENARIO FORK -> ADVANCED (divergence): rewritten body, re-linked chain, plausible tip", async () => {
  // a fork built off-chain is a different file whose tip differs (DESIGN.md §5)
  const forkedBodies = BODIES.slice();
  forkedBodies[3] = { ...forkedBodies[3], kind: "scout.report.REWRITTEN" };
  const forked = buildQmr1Store(forkedBodies);
  const current = await deriveQmr1Tip(forked); // re-derives fine — an honest-LOOKING state
  assert.equal(current.ok, true);
  const v = divergenceVerdict({ history: [{ day: "2026-10-02", tip: tip4 }], current });
  assert.equal(v.verdict, "ADVANCED");
  assert.equal(v.divergence, true);
});

test("SCENARIO STALE ANCHOR -> ADVANCED (divergence): honest store appended past the last anchor", async () => {
  const history = [{ day: "2026-10-01", tip: tip3 }];
  const current = await deriveQmr1Tip(store4); // row 4 added after the anchor
  const v = divergenceVerdict({ history, current });
  assert.equal(v.verdict, "ADVANCED");
  assert.equal(v.divergence, true);
});

test("SCENARIO MISSING-ANCHOR (divergence): derivable current tip, nothing anchored", async () => {
  const current = await deriveQmr1Tip(store4);
  const v = divergenceVerdict({ history: [], current });
  assert.equal(v.verdict, "MISSING-ANCHOR");
  assert.equal(v.divergence, true);
});

test("INDETERMINATE: unreachable source is recorded, never guessed into a verdict", async () => {
  const v = divergenceVerdict({ history: [{ day: "2026-10-02", tip: tip4 }], current: { ok: false, reason: "raw fetch HTTP 503" } });
  assert.equal(v.verdict, "INDETERMINATE");
  assert.equal(v.divergence, false);
});

test("CORRUPT-ANCHOR law: a tampered anchor RECORD fails its sha256 re-derivation (corruption, not divergence)", async () => {
  const record = { lane: "qmr1", day: "2026-10-02", tip: tip4, anchoredAt: "2026-10-02T10:00:00Z", prevTipForLane: tip3, note: "", sha256: null };
  record.sha256 = await anchorSha256(record);
  assert.equal(record.sha256, await sha256hex(canonical({
    lane: record.lane, day: record.day, tip: record.tip,
    anchoredAt: record.anchoredAt, prevTipForLane: record.prevTipForLane,
  })), "the sweep's re-derivation path agrees with logic.mjs's");

  const tamperedTip = { ...record, tip: "e".repeat(64) };
  const rederived = await sha256hex(canonical({
    lane: tamperedTip.lane, day: tamperedTip.day, tip: tamperedTip.tip,
    anchoredAt: tamperedTip.anchoredAt, prevTipForLane: tamperedTip.prevTipForLane,
  }));
  assert.notEqual(rederived, tamperedTip.sha256, "the anchored scar itself was edited -> corruption class");
});
