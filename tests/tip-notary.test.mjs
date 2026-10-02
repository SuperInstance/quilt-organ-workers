/**
 * tests/tip-notary.test.mjs — quilt-tip-notary law, stdlib-only (node --test).
 *
 * Covers: named fail-closed validation (E_TIP_FORMAT / E_LANE_FORMAT /
 * E_DAY_FORMAT / E_NOTE_FORMAT / E_UNKNOWN_FIELD / E_BODY_FORMAT), real
 * calendar-day law, content-addressed record integrity (sha256 re-derivation,
 * tamper -> E_INTEGRITY), per-lane chaining (prevTipForLane), idempotent
 * same-tip POST, E_DAY_CONFLICT on a different tip for the same day, and a
 * full worker round-trip against an in-memory KV mock.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  canonical,
  sha256hex,
  isRealDay,
  validateAnchorInput,
  anchorSha256,
  selectPrevTip,
} from "../src/tip-notary/logic.mjs";
import notary from "../src/tip-notary/worker.js";

const T1 = "a".repeat(64);
const T2 = "b".repeat(64);
const T3 = "c".repeat(64);

// ---- validation -------------------------------------------------------------

test("validateAnchorInput accepts a well-formed anchor", () => {
  const v = validateAnchorInput({ lane: "qmr1", day: "2026-10-02", tip: T1, note: "hello" });
  assert.equal(v.error, undefined);
  assert.deepEqual(v.value, { lane: "qmr1", day: "2026-10-02", tip: T1, note: "hello" });
});

test("validateAnchorInput defaults note to empty string", () => {
  const v = validateAnchorInput({ lane: "qmr1", day: "2026-10-02", tip: T1 });
  assert.equal(v.value.note, "");
});

test("E_TIP_FORMAT: wrong length, non-hex, uppercase, non-string", () => {
  for (const tip of ["abc", "Z".repeat(64), "A".repeat(64), 123, null, T1.slice(1)]) {
    const v = validateAnchorInput({ lane: "qmr1", day: "2026-10-02", tip });
    assert.equal(v.error, "E_TIP_FORMAT", `tip=${JSON.stringify(tip)}`);
  }
});

test("E_LANE_FORMAT: uppercase, slash, leading dash, too long, empty, non-string", () => {
  for (const lane of ["QMR1", "a/b", "-a", "_a", "a".repeat(65), "", 7, null]) {
    const v = validateAnchorInput({ lane, day: "2026-10-02", tip: T1 });
    assert.equal(v.error, "E_LANE_FORMAT", `lane=${JSON.stringify(lane)}`);
  }
});

test("E_DAY_FORMAT: shape violations and impossible calendar dates", () => {
  for (const day of ["2026-10-2", "26-10-02", "2026/10/02", "2026-13-01", "2026-00-10", "2026-02-30", "2026-04-31", "2025-02-29", "garbage", 20261002, null]) {
    const v = validateAnchorInput({ lane: "qmr1", day, tip: T1 });
    assert.equal(v.error, "E_DAY_FORMAT", `day=${JSON.stringify(day)}`);
  }
});

test("isRealDay: leap years honored (2024-02-29 yes, 2025-02-29 no)", () => {
  assert.equal(isRealDay("2024-02-29"), true);
  assert.equal(isRealDay("2025-02-29"), false);
  assert.equal(isRealDay("2000-02-29"), true);
  assert.equal(isRealDay("1900-02-29"), false);
});

test("E_NOTE_FORMAT: non-string or oversized note", () => {
  assert.equal(validateAnchorInput({ lane: "l", day: "2026-10-02", tip: T1, note: 42 }).error, "E_NOTE_FORMAT");
  assert.equal(validateAnchorInput({ lane: "l", day: "2026-10-02", tip: T1, note: "x".repeat(513) }).error, "E_NOTE_FORMAT");
  assert.equal(validateAnchorInput({ lane: "l", day: "2026-10-02", tip: T1, note: "x".repeat(512) }).error, undefined);
});

test("E_UNKNOWN_FIELD: strictness on purpose (the qmr1 law)", () => {
  const v = validateAnchorInput({ lane: "l", day: "2026-10-02", tip: T1, seq: 3 });
  assert.equal(v.error, "E_UNKNOWN_FIELD");
});

test("E_BODY_FORMAT: non-object bodies", () => {
  for (const body of [null, "x", 42, [], undefined]) {
    assert.equal(validateAnchorInput(body).error, "E_BODY_FORMAT");
  }
});

// ---- content-addressed integrity --------------------------------------------

test("anchorSha256 is key-order independent and note-presence deterministic", async () => {
  const a = { lane: "l", day: "2026-10-02", tip: T1, anchoredAt: "2026-10-02T00:00:00Z", prevTipForLane: null, note: "n" };
  const b = { note: "n", prevTipForLane: null, anchoredAt: "2026-10-02T00:00:00Z", tip: T1, day: "2026-10-02", lane: "l" };
  assert.equal(await anchorSha256(a), await anchorSha256(b));
  const noNote = { ...a, note: "" };
  assert.equal(await anchorSha256(noNote), await anchorSha256({ ...a, note: undefined }), "empty and absent note canonicalize identically");
  assert.notEqual(await anchorSha256(a), await anchorSha256(noNote), "note presence changes the content address");
});

test("canonical is the recursive key-sorted no-whitespace law, fail-closed on poison", () => {
  assert.equal(canonical({ b: 1, a: { d: [2, 1], c: "x" } }), '{"a":{"c":"x","d":[2,1]},"b":1}');
  assert.throws(() => canonical({ x: undefined }));
  assert.throws(() => canonical({ x: NaN }));
  assert.throws(() => canonical({ x: 2n }));
});

test("tampering any field breaks the sha256 re-derivation (corruption, named)", async () => {
  const record = { lane: "l", day: "2026-10-02", tip: T1, anchoredAt: "2026-10-02T00:00:00Z", prevTipForLane: null, note: "", sha256: null };
  record.sha256 = await anchorSha256(record);
  assert.equal(record.sha256, await anchorSha256(record), "honest record re-derives");
  for (const tampered of [
    { ...record, tip: T2 },
    { ...record, day: "2026-10-03" },
    { ...record, anchoredAt: "2026-10-02T00:00:01Z" },
    { ...record, prevTipForLane: T3 },
    { ...record, note: "rewritten" },
  ]) {
    assert.notEqual(await anchorSha256(tampered), record.sha256, JSON.stringify(tampered));
  }
  // the sha256 FIELD itself is not part of the canonical body — but a stored
  // field that disagrees with the re-derivation is exactly how corruption shows
  const storedLies = { ...record, sha256: "f".repeat(64) };
  assert.notEqual(storedLies.sha256, await anchorSha256(storedLies), "stored sha256 fails re-derivation");
});

// ---- per-lane chaining -------------------------------------------------------

test("selectPrevTip: greatest earlier day, null for first anchor, day-boundary exact", () => {
  const history = [
    { day: "2026-09-30", tip: T1 },
    { day: "2026-10-01", tip: T2 },
    { day: "2026-10-03", tip: T3 },
  ];
  assert.equal(selectPrevTip(history, "2026-10-04"), T3, "prev = latest strictly earlier");
  assert.equal(selectPrevTip(history, "2026-10-03"), T2, "same day never its own prev");
  assert.equal(selectPrevTip(history, "2026-09-30"), null, "first anchor has no prev");
  assert.equal(selectPrevTip([], "2026-10-04"), null);
});

// ---- worker round-trip against an in-memory KV mock --------------------------

function mockKV() {
  const m = new Map();
  return {
    async get(key, opts) {
      const v = m.get(key);
      if (v === undefined) return null;
      return opts?.type === "json" ? JSON.parse(v) : v;
    },
    async put(key, val) {
      m.set(key, String(val));
    },
    async list({ prefix = "", cursor, limit = 1000 } = {}) {
      const all = [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
      let start = 0;
      if (cursor) {
        const idx = all.findIndex((k) => k > cursor);
        start = idx === -1 ? all.length : idx;
      }
      const keys = all.slice(start, start + limit).map((name) => ({ name }));
      const list_complete = start + limit >= all.length;
      return { keys, list_complete, cursor: list_complete ? undefined : keys[keys.length - 1]?.name };
    },
    _map: m,
  };
}

const env = { ORGANS: mockKV(), WORKER_UPLOAD_TOKEN: "wave67-selftest-token" };
const call = async (path, init = {}) => {
  const req = new Request(`https://quilt-tip-notary.test${path}`, init);
  return notary.fetch(req, env);
};
const jbody = async (resp) => await resp.json();

test("worker: GET /health answers ready", async () => {
  const r = await call("/health");
  assert.equal(r.status, 200);
  const b = await jbody(r);
  assert.equal(b.service, "quilt-tip-notary");
  assert.equal(b.neverDeletes, true);
});

test("worker: POST /anchor requires the token (401 E_UNAUTHORIZED)", async () => {
  const r = await call("/anchor", { method: "POST", body: JSON.stringify({ lane: "l", day: "2026-10-02", tip: T1 }) });
  assert.equal(r.status, 401);
  assert.equal((await jbody(r)).error, "E_UNAUTHORIZED");
});

test("worker: validation errors are named and fail-closed over HTTP", async () => {
  const auth = { method: "POST", headers: { authorization: "Bearer wave67-selftest-token" } };
  for (const [body, error] of [
    [{ lane: "l", day: "2026-10-02", tip: "nope" }, "E_TIP_FORMAT"],
    [{ lane: "BAD LANE", day: "2026-10-02", tip: T1 }, "E_LANE_FORMAT"],
    [{ lane: "l", day: "2026-02-30", tip: T1 }, "E_DAY_FORMAT"],
    [{ lane: "l", day: "2026-10-02", tip: T1, extra: 1 }, "E_UNKNOWN_FIELD"],
  ]) {
    const r = await call("/anchor", { ...auth, body: JSON.stringify(body) });
    assert.equal(r.status, 400);
    assert.equal((await jbody(r)).error, error);
  }
  const r = await call("/anchor", { ...auth, body: "not json" });
  assert.equal(r.status, 400);
  assert.equal((await jbody(r)).error, "E_BODY_FORMAT");
});

test("worker: anchor -> chain -> GET back -> latest -> status, integrity ok throughout", async () => {
  const auth = { method: "POST", headers: { authorization: "Bearer wave67-selftest-token", "content-type": "application/json" } };

  const d1 = await call("/anchor", { ...auth, body: JSON.stringify({ lane: "lane1", day: "2026-10-01", tip: T1, note: "day one" }) });
  assert.equal(d1.status, 201);
  const rec1 = (await jbody(d1)).record;
  assert.equal(rec1.prevTipForLane, null, "first anchor of the lane has no prev");
  assert.equal(rec1.sha256, await anchorSha256(rec1), "record is content-addressed");

  const d2 = await call("/anchor", { ...auth, body: JSON.stringify({ lane: "lane1", day: "2026-10-02", tip: T2 }) });
  assert.equal(d2.status, 201);
  const rec2 = (await jbody(d2)).record;
  assert.equal(rec2.prevTipForLane, T1, "second anchor chains to the first tip");

  const d3 = await call("/anchor", { ...auth, body: JSON.stringify({ lane: "lane2", day: "2026-10-02", tip: T3 }) });
  assert.equal(d3.status, 201);
  assert.equal((await jbody(d3)).record.prevTipForLane, null, "different lane, independent chain");

  const g1 = await call("/anchor/lane1/2026-10-01");
  assert.equal(g1.status, 200);
  assert.equal((await jbody(g1)).integrity, "ok");

  const lat = await call("/latest/lane1");
  assert.equal(lat.status, 200);
  assert.equal((await jbody(lat)).latest.tip, T2);

  const hist = await call("/anchor/lane1");
  assert.deepEqual((await jbody(hist)).days, ["2026-10-01", "2026-10-02"]);

  const st = await call("/status");
  assert.equal(st.status, 200);
  const sb = await jbody(st);
  assert.equal(sb.lanesTracked, 2);
  assert.equal(sb.healthy, true);
  assert.deepEqual(sb.lanes.map((l) => l.lane), ["lane1", "lane2"]);
});

test("worker: same {lane,day,tip} is idempotent; a different tip is E_DAY_CONFLICT (409)", async () => {
  const auth = { method: "POST", headers: { authorization: "Bearer wave67-selftest-token", "content-type": "application/json" } };
  const again = await call("/anchor", { ...auth, body: JSON.stringify({ lane: "lane1", day: "2026-10-01", tip: T1 }) });
  assert.equal(again.status, 200);
  assert.equal((await jbody(again)).idempotent, true);

  const conflict = await call("/anchor", { ...auth, body: JSON.stringify({ lane: "lane1", day: "2026-10-01", tip: T3 }) });
  assert.equal(conflict.status, 409);
  assert.equal((await jbody(conflict)).error, "E_DAY_CONFLICT");
});

test("worker: a tampered KV row is answered E_INTEGRITY (500), fail-closed", async () => {
  // write a record honestly, then corrupt it behind the worker's back
  const key = "anchor:lane-tamper:2026-10-01";
  const record = { lane: "lane-tamper", day: "2026-10-01", tip: T1, anchoredAt: "2026-10-01T00:00:00Z", prevTipForLane: null, note: "", sha256: null };
  record.sha256 = await anchorSha256(record);
  await env.ORGANS.put(key, JSON.stringify(record));
  assert.equal((await call(`/anchor/lane-tamper/2026-10-01`)).status, 200, "sanity: honest row reads ok");

  const tampered = { ...record, tip: T2 };
  await env.ORGANS.put(key, JSON.stringify(tampered));
  const r = await call("/anchor/lane-tamper/2026-10-01");
  assert.equal(r.status, 500);
  assert.equal((await jbody(r)).error, "E_INTEGRITY");

  await env.ORGANS.put(`${"notary-latest:"}lane-tamper`, "2026-10-01");
  const st = await jbody(await call("/status"));
  assert.equal(st.healthy, false, "/status goes unhealthy when any anchor row fails integrity");
});
