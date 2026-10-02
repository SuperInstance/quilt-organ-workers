/**
 * quilt-tip-notary — the fleet's external tip-anchor notary (wave-67, 67-a).
 *
 * The wave-66 seed-dna census (quilt-atlas 6df5d1d) found three repos
 * (quilt-nn, quilt-qcells, slackwater-quilt) stating the same honest limit:
 * bare hash chains cannot detect tail truncation without an anchored tip.
 * qmr1 DESIGN.md §5 says it verbatim: "v2 anchors the tip externally — e.g.
 * periodic tip commit into ... the organ-workers KV store; then truncation is
 * a detectable count/tip regression against the anchor". This worker IS that
 * anchor. Erised-fleet-table's quest-log converged independently: "an anchor
 * is a scar you choose in advance."
 *
 * A lane (any fleet receipt chain: qmr1 store.jsonl, erised ledger, organ
 * chains, cot-quilt run ledgers, quilt-nn epochs) POSTs its 32-byte tip per
 * day; the notary chains the anchors PER LANE (each anchor records
 * prevTipForLane) so the anchored history is itself an append-only scar chain
 * outside the patient. The organ-watcher's divergence delta compares the
 * lane's CURRENT tip against this history every hour (see
 * src/organ-watcher/divergence.mjs) — corruption (chain re-derivation fails)
 * is the existing disease; DIVERGENCE (two honest states disagree) is the new
 * one this worker makes detectable.
 *
 * Sibling, not rival: quilt-tip-anchor (wave-66) is the chain-level timestamp
 * witness (chain_id+seq, HMAC-signed, own KV namespace). tip-notary is the
 * lane/day-chained anchor in the SHARED organ store (quilt-organ-store KV,
 * binding ORGANS — the same namespace the boot-loader and watcher hold), so
 * the watcher reads anchors over KV with no worker→worker fetch (blocked by
 * the platform; receipted in receipts/ORGAN-WATCHER.md F1). Nothing is ever
 * deleted; rows are content-addressed and re-derived on read.
 *
 * Endpoints (Bearer/x-quilt-token WORKER_UPLOAD_TOKEN on POST; GETs public):
 *   POST /anchor               {lane, day, tip, note?} -> 201 record (200 + idempotent
 *                              if the same {lane,day,tip} is re-posted; 409
 *                              E_DAY_CONFLICT if the day holds a DIFFERENT tip —
 *                              a chosen scar is never overwritten)
 *   GET  /anchor/{lane}/{day}  the record, integrity re-derived (E_INTEGRITY on fail)
 *   GET  /anchor/{lane}        lane history: days + latest record
 *   GET  /latest/{lane}        most recent anchor record for the lane
 *   GET  /status               {lanesTracked, lanes:[{lane, day, tip, integrity}], healthy}
 *   GET  /health               liveness
 *
 * KV layout (shared quilt-organ-store namespace, prefixes chosen disjoint
 * from the loader's meta:/organ:* and the watcher's watch:*):
 *   anchor:{lane}:{day}      -> record {lane, day, tip, anchoredAt, prevTipForLane, note?, sha256}
 *   notary-latest:{lane}     -> day string (pointer to the lane's most recent anchor)
 *
 * Fail-closed named errors: E_BODY_FORMAT, E_LANE_FORMAT, E_DAY_FORMAT,
 * E_TIP_FORMAT, E_NOTE_FORMAT, E_UNKNOWN_FIELD, E_DAY_CONFLICT, E_NOT_ANCHORED,
 * E_LANE_UNANCHORED, E_INTEGRITY, E_UNAUTHORIZED, E_NOT_FOUND.
 */

import {
  canonical,
  anchorBody,
  anchorSha256,
  validateAnchorInput,
  selectPrevTip,
} from "./logic.mjs";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, x-quilt-token",
  "Access-Control-Max-Age": "86400",
};
const ANCHOR_PREFIX = "anchor:";
const LATEST_PREFIX = "notary-latest:";
const MAX_LANES = 256;
const MAX_ANCHORS_PER_LANE = 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

const fail = (status, error, detail) => json({ ok: false, error, detail }, status);

async function authOk(request, env) {
  if (!env || !env.WORKER_UPLOAD_TOKEN) return false;
  const header = request.headers.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const alt = (request.headers.get("x-quilt-token") || "").trim();
  const presented = bearer || alt;
  if (!presented) return false;
  // constant-time-ish: compare digests, not strings
  const h = async (s) => {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  return (await h(presented)) === (await h(env.WORKER_UPLOAD_TOKEN));
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Fetch + integrity-check one anchor record. Returns {record} | {error, detail}. */
async function getIntegrityChecked(env, key) {
  const raw = await env.ORGANS.get(key, { type: "json" }).catch(() => null);
  if (!raw) return { error: "E_NOT_ANCHORED", detail: `no record at ${key}` };
  const expected = await anchorSha256(raw).catch(() => null);
  if (!expected || raw.sha256 !== expected) {
    return {
      error: "E_INTEGRITY",
      detail: "record failed sha256 re-derivation (stored sha256 does not match canonical body) — corruption, fail-closed",
      record: raw,
      expected,
    };
  }
  return { record: raw };
}

/** All anchor records for one lane, oldest first (KV list is lexicographic; ISO days sort). */
async function laneRecords(env, lane) {
  const keys = [];
  let cursor;
  do {
    const page = await env.ORGANS.list({ prefix: `${ANCHOR_PREFIX}${lane}:`, limit: 1000, cursor });
    for (const k of page.keys) keys.push(k.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && keys.length < MAX_ANCHORS_PER_LANE);
  const records = [];
  for (const key of keys.slice(0, MAX_ANCHORS_PER_LANE)) {
    const r = await env.ORGANS.get(key, { type: "json" }).catch(() => null);
    if (r) records.push(r);
  }
  records.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return records;
}

async function anchorPost(request, env) {
  if (!(await authOk(request, env))) {
    return fail(401, "E_UNAUTHORIZED", "present WORKER_UPLOAD_TOKEN via 'Authorization: Bearer <token>' or 'x-quilt-token'");
  }
  const body = await request.json().catch(() => undefined);
  const v = validateAnchorInput(body);
  if (v.error) return fail(400, v.error, v.detail);
  const { lane, day, tip, note } = v.value;

  const key = `${ANCHOR_PREFIX}${lane}:${day}`;
  const existing = await env.ORGANS.get(key, { type: "json" }).catch(() => null);
  if (existing) {
    if (existing.tip === tip) {
      return json({ ok: true, anchored: true, idempotent: true, record: existing }, 200);
    }
    return fail(409, "E_DAY_CONFLICT", `anchor:${lane}:${day} already holds tip ${existing.tip} — a chosen scar is never overwritten (never-delete-data)`);
  }

  const history = await laneRecords(env, lane);
  const prevTipForLane = selectPrevTip(history, day);
  const anchoredAt = new Date().toISOString();
  const record = { lane, day, tip, anchoredAt, prevTipForLane, ...(note ? { note } : {}), sha256: null };
  record.sha256 = await anchorSha256(record);

  await env.ORGANS.put(key, JSON.stringify(record));
  const latestDay = await env.ORGANS.get(`${LATEST_PREFIX}${lane}`);
  if (latestDay === null || day >= latestDay) {
    await env.ORGANS.put(`${LATEST_PREFIX}${lane}`, day);
  }
  return json({ ok: true, anchored: true, idempotent: false, record }, 201);
}

async function statusPayload(env) {
  const lanes = [];
  let cursor;
  do {
    const page = await env.ORGANS.list({ prefix: LATEST_PREFIX, limit: 1000, cursor });
    for (const k of page.keys) lanes.push(k.name.slice(LATEST_PREFIX.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && lanes.length < MAX_LANES);

  const out = [];
  let healthy = true;
  for (const lane of lanes.slice(0, MAX_LANES)) {
    const day = await env.ORGANS.get(`${LATEST_PREFIX}${lane}`);
    if (day === null) continue;
    const got = await getIntegrityChecked(env, `${ANCHOR_PREFIX}${lane}:${day}`);
    if (got.error) {
      healthy = false;
      out.push({ lane, day, integrity: got.error, detail: got.detail });
      continue;
    }
    const r = got.record;
    out.push({
      lane,
      day: r.day,
      tip: r.tip,
      anchoredAt: r.anchoredAt,
      prevTipForLane: r.prevTipForLane,
      integrity: "ok",
    });
  }
  out.sort((a, b) => (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0));
  return {
    ok: true,
    service: "quilt-tip-notary",
    law: "append-only lane/day tip anchors; content-addressed sha256 re-derived on every read; nothing deleted",
    lanesTracked: out.length,
    lanes: out,
    healthy: healthy && out.length >= 0,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    if (method === "GET" && (path === "/" || path === "/health")) {
      return json({
        ok: true,
        service: "quilt-tip-notary",
        purpose: "external tip-anchor notary: per-lane, per-day anchored 32-byte tips so tail truncation of any fleet chain is detectable by regression against the anchor",
        endpoints: {
          "POST /anchor": "{lane, day, tip, note?} — auth WORKER_UPLOAD_TOKEN",
          "GET /anchor/{lane}/{day}": "the record (integrity re-derived)",
          "GET /anchor/{lane}": "lane history + latest",
          "GET /latest/{lane}": "most recent anchor for the lane",
          "GET /status": "lanes tracked + last anchor per lane + healthy",
        },
        kv: { namespace: "quilt-organ-store (shared, binding ORGANS)", keys: ["anchor:{lane}:{day}", "notary-latest:{lane}"] },
        sibling: "quilt-tip-anchor (wave-66) — chain_id/seq timestamp witness, separate namespace",
        neverDeletes: true,
      });
    }

    if (method === "POST" && path === "/anchor") return anchorPost(request, env);

    if (method === "GET" && path === "/status") return json(await statusPayload(env));

    let m = path.match(/^\/anchor\/([^/]+)\/([^/]+)$/);
    if (m && method === "GET") {
      const lane = safeDecode(m[1]);
      const day = safeDecode(m[2]);
      if (lane === null) return fail(400, "E_LANE_FORMAT", "lane segment is not decodable");
      if (day === null) return fail(400, "E_DAY_FORMAT", "day segment is not decodable");
      const got = await getIntegrityChecked(env, `${ANCHOR_PREFIX}${lane}:${day}`);
      if (got.error) return fail(got.error === "E_NOT_ANCHORED" ? 404 : 500, got.error, got.detail);
      return json({ ok: true, record: got.record, integrity: "ok" });
    }

    m = path.match(/^\/latest\/([^/]+)$/);
    if (m && method === "GET") {
      const lane = safeDecode(m[1]);
      if (lane === null) return fail(400, "E_LANE_FORMAT", "lane segment is not decodable");
      const day = await env.ORGANS.get(`${LATEST_PREFIX}${lane}`);
      if (day === null) return fail(404, "E_LANE_UNANCHORED", `lane "${lane}" has no anchors`);
      const got = await getIntegrityChecked(env, `${ANCHOR_PREFIX}${lane}:${day}`);
      if (got.error) return fail(500, got.error, got.detail);
      return json({ ok: true, lane, latest: got.record, integrity: "ok" });
    }

    m = path.match(/^\/anchor\/([^/]+)$/);
    if (m && method === "GET") {
      const lane = safeDecode(m[1]);
      if (lane === null) return fail(400, "E_LANE_FORMAT", "lane segment is not decodable");
      const records = await laneRecords(env, lane);
      if (records.length === 0) return fail(404, "E_LANE_UNANCHORED", `lane "${lane}" has no anchors`);
      return json({ ok: true, lane, days: records.map((r) => r.day), latest: records[records.length - 1], count: records.length });
    }

    return fail(404, "E_NOT_FOUND", `no route: ${method} ${path}`);
  },
};
