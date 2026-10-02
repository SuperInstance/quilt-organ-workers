/**
 * organ-watcher — fleet boot-readiness monitor for the quilt organ store
 * (Cloudflare Worker, cron-triggered, KV-backed; free-tier friendly).
 *
 * Backlog item 1 from the quilt-organ-workers README, landed in wave 64 (64-c).
 * Wave 67 (67-a) adds the DIVERGENCE DELTA (src/organ-watcher/divergence.mjs):
 * after every cycle, anchored lane tips (quilt-tip-notary's KV keys) are
 * compared against each lane's CURRENT tip — corruption (re-derivation fails)
 * was the old disease; DIVERGENCE (two honest states disagree) is the new one.
 *
 * What it does, once per hour (cron "0 * * * *"; also forceable via POST /check):
 *   1. lists every organ id from the organ-boot-loader KV (meta:* keys — the SAME
 *      namespace the loader writes, bound here as ORGANS; never deletes anything),
 *   2. INDEPENDENTLY re-derives every commitment server-side from the stored
 *      bytes (manifest digest == id, whole-state stateHash, receipt chain under
 *      the organ's own dialect law, and for canonical-dialect organs also the
 *      manifestHash self-cover + cellsSha256 + per-cell stateHashes) — a monitor
 *      shares NO code path with the service it watches. (Design note: the
 *      alternative — calling the loader's /verify over HTTP from this worker —
 *      was live-tested first and is BLOCKED by the platform: same-account
 *      worker→worker fetches on *.workers.dev get an instant unparseable 404
 *      from the edge (error 1042 class, ~2 ms). Receipted in
 *      receipts/ORGAN-WATCHER.md; re-derivation is the sanctioned fallback per
 *      the 64-c mission and is strictly stronger for drift monitoring anyway.)
 *   3. records one KV row per organ: {id, name, dialect, bootable, checkedAt,
 *      driftDetected, receiptTip, ...} under key watch:{organId}, plus a
 *      watch:_lastRun summary row,
 *   4. DIVERGENCE DELTA: for each lane with anchored tips (quilt-tip-notary,
 *      anchor:* / notary-latest:* keys in the SAME KV) ∪ each configured lane,
 *      re-derives the lane's CURRENT tip (GitHub raw chain files / organ tips
 *      from this sweep) and compares against the anchored history; writes one
 *      watch:_divergence:{lane} row per lane. Any REGRESSED / ADVANCED /
 *      MISSING-ANCHOR verdict flips fleetHealth.state to DIVERGENCE-DETECTED.
 *      A tampered ANCHOR row (sha256 re-derivation fails) is CORRUPT-ANCHOR —
 *      the EXISTING corruption class, reported separately, never conflated.
 *   5. GET /status serves the dashboard: every last check + divergence detail
 *      + a fleet health summary. Open (CORS *) like the rest of the fleet.
 *
 * driftDetected: true  = a stored organ FAILED re-derivation (FINDING —
 *                        receipted, never deleted; the organ bytes are
 *                        immutable evidence),
 *                false = every commitment re-derives (boot-ready),
 *                null  = indeterminate (dialect unknown — receipted as finding).
 *
 * Bindings:
 *   ORGANS               KV namespace — the SAME quilt-organ-store namespace the
 *                        organ-boot-loader and quilt-tip-notary use (read for
 *                        organs + anchors, write for watch rows)
 *   WORKER_UPLOAD_TOKEN  secret — guards POST /check (same shared fleet token)
 *   LOADER_URL           plain_text — informational: which loader this watcher monitors
 */

import { divergenceSweep } from "./divergence.mjs";

const WATCH_PREFIX = "watch:";
const LAST_RUN_KEY = "watch:_lastRun";
const DIVERGENCE_PREFIX = "watch:_divergence:";
const ORGAN_META_PREFIX = "meta:";
const LIST_PAGE_LIMIT = 64;
const MAX_ORGANS = 512; // hard stop for free-tier discipline (KV reads/cycle <= ~2x this)

const CANONICAL_SCHEMA = "quilt.organ.manifest/v1";
const LEGACY_SCHEMA = "quilt.organ.v1";
const SHA256_RE = /^[a-f0-9]{64}$/;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, x-quilt-token",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS, ...extraHeaders },
  });
}

function fail(status, error, extraHeaders = {}) {
  return json({ ok: false, error }, status, extraHeaders);
}

// ---- independent re-derivation law (the store's identity laws, re-implemented
// ---- here so the watcher verifies bytes, not the loader's self-report) -------

function canonical(value, _path = "$") {
  if (value === undefined) {
    throw new TypeError(`canonical: undefined at ${_path}`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`canonical: non-finite number at ${_path}`);
    return JSON.stringify(value);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`canonical: ${typeof value} at ${_path} is not serializable`);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v, i) => canonical(v, `${_path}[${i}]`)).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k], `${_path}.${k}`)).join(",") + "}";
}

async function sha256hex(str) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authOk(request, env) {
  if (!env || !env.WORKER_UPLOAD_TOKEN) return false;
  const header = request.headers.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const alt = (request.headers.get("x-quilt-token") || "").trim();
  const presented = bearer || alt;
  if (!presented) return false;
  return (await sha256hex(presented)) === (await sha256hex(env.WORKER_UPLOAD_TOKEN));
}

/** Canonical dialect receipt chain (toolkit law): hash = sha256(canon({seq, op, prev})),
 *  GENESIS-anchored at receiptRange.start, full window. null if sound. */
async function checkCanonicalChain(receipts, manifest) {
  const rr = manifest.receiptRange;
  if (receipts.length !== rr.count) {
    return `receipts.length (${receipts.length}) != receiptRange.count (${rr.count})`;
  }
  let expectedPrev = manifest.genesis.prevHash;
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    if (typeof r !== "object" || r === null || Array.isArray(r)) return `receipts[${i}] not an object`;
    if (r.seq !== rr.start + i) return `receipts[${i}].seq discontinuity`;
    if (r.prev !== expectedPrev) return `receipts[${i}].prev does not link`;
    if (typeof r.op !== "object" || r.op === null || Array.isArray(r.op) || typeof r.op.type !== "string" || r.op.type === "") {
      return `receipts[${i}].op must be an object with a non-empty string type`;
    }
    if (typeof r.hash !== "string" || !SHA256_RE.test(r.hash)) return `receipts[${i}].hash not 64-hex`;
    const recomputed = await sha256hex(canonical({ seq: r.seq, op: r.op, prev: r.prev }));
    if (recomputed !== r.hash) return `receipts[${i}] hash mismatch: recomputed ${recomputed}, stored ${r.hash}`;
    expectedPrev = r.hash;
  }
  return null;
}

/** Legacy dialect receipt chain (worker law): digest = sha256(canon(receipt minus digest)),
 *  "genesis"-anchored, seq 1-based, digest == receiptRange[i]. null if sound. */
async function checkLegacyChain(receipts, receiptRange) {
  if (receipts.length !== receiptRange.length) {
    return `receipts.length (${receipts.length}) != receiptRange.length (${receiptRange.length})`;
  }
  let prev = "genesis";
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    if (typeof r !== "object" || r === null) return `receipts[${i}] not an object`;
    if (r.prev !== prev) return `receipts[${i}].prev does not link`;
    const { digest, ...rest } = r;
    if (typeof digest !== "string" || !SHA256_RE.test(digest)) return `receipts[${i}].digest not 64-hex`;
    if (rest.seq !== i + 1) return `receipts[${i}].seq out of order`;
    const recomputed = await sha256hex(canonical(rest));
    if (recomputed !== digest) return `receipts[${i}] digest mismatch: recomputed ${recomputed}, stored ${digest}`;
    if (receiptRange[i] !== digest) return `receipts[${i}].digest != receiptRange[${i}]`;
    prev = digest;
  }
  return null;
}

/** Fully independent boot-readiness verdict from the STORED bytes.
 *  Mirrors /verify semantics without sharing its code path or runtime. */
async function rederiveBoot(bundle) {
  const checks = {};
  checks.manifestDigestMatchesId = (await sha256hex(canonical(bundle.manifest))) === bundle.id;
  checks.stateHashMatchesState =
    (await sha256hex(canonical(bundle.state))) === (bundle.manifest && bundle.manifest.stateHash);
  let chainReason = null;
  if (bundle.schema === CANONICAL_SCHEMA) {
    const { manifestHash: _ignored, ...rest } = bundle.manifest;
    checks.manifestHashSelfCover = (await sha256hex(canonical(rest))) === bundle.manifest.manifestHash;
    checks.cellsSha256MatchesState =
      (await sha256hex(canonical(bundle.state?.cells))) === bundle.manifest?.state?.cellsSha256;
    checks.perCellStateHashes = true;
    const stateCells = bundle.state?.cells;
    if (typeof stateCells === "object" && stateCells !== null && !Array.isArray(stateCells) && Array.isArray(bundle.manifest.cells)) {
      for (const c of bundle.manifest.cells) {
        if (typeof c?.id !== "string") continue;
        if (!Object.prototype.hasOwnProperty.call(stateCells, c.id)) { checks.perCellStateHashes = false; break; }
        if ((await sha256hex(canonical(stateCells[c.id]))) !== c.stateHash) { checks.perCellStateHashes = false; break; }
      }
    } else if (Array.isArray(bundle.manifest.cells) && bundle.manifest.cells.length > 0) {
      checks.perCellStateHashes = null; // no map to check against; not boot-blocking beyond cellsSha256
    }
    if (Array.isArray(bundle.receipts)) {
      chainReason = await checkCanonicalChain(bundle.receipts, bundle.manifest);
    }
  } else {
    if (Array.isArray(bundle.receipts)) {
      chainReason = await checkLegacyChain(bundle.receipts, bundle.manifest.receiptRange);
    }
  }
  checks.receiptChain = chainReason === null;
  const bootable =
    checks.manifestDigestMatchesId === true &&
    checks.stateHashMatchesState === true &&
    checks.receiptChain === true &&
    checks.manifestHashSelfCover !== false &&
    checks.cellsSha256MatchesState !== false &&
    checks.perCellStateHashes !== false;
  return { checks, chainReason, bootable };
}

/** One full check cycle over every organ in the store. */
async function runCycle(env, trigger) {
  const t0 = Date.now();
  const ids = [];
  let cursor;
  do {
    const page = await env.ORGANS.list({ prefix: ORGAN_META_PREFIX, limit: LIST_PAGE_LIMIT, cursor });
    for (const key of page.keys) ids.push(key.name.slice(ORGAN_META_PREFIX.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && ids.length < MAX_ORGANS);
  if (ids.length > MAX_ORGANS) ids.length = MAX_ORGANS;

  const checks = [];
  const organTips = new Map(); // organId -> {tip, rows} — current tips for divergence sources of kind organ_store
  for (const id of ids) {
    const record = { id, checkedAt: new Date().toISOString() };
    const raw = await env.ORGANS.get(`organ:${id}`, { type: "json" }).catch(() => null);
    if (raw && raw.bundle && raw.bundle.manifest) {
      record.dialect = raw.bundle.schema ?? raw.bundle.schemaVersion ?? "unknown";
      record.name = raw.bundle.manifest?.name ?? null;
      try {
        const verdict = await rederiveBoot({ ...raw.bundle, id });
        record.bootable = verdict.bootable;
        record.rederived = verdict.checks;
        if (verdict.chainReason) record.reason = verdict.chainReason;
        record.driftDetected = verdict.bootable ? false : true;
        if (verdict.bootable && Array.isArray(raw.bundle.receipts) && raw.bundle.receipts.length > 0) {
          const last = raw.bundle.receipts[raw.bundle.receipts.length - 1];
          const tip = typeof last?.hash === "string" ? last.hash : typeof last?.digest === "string" ? last.digest : null;
          if (tip) {
            record.receiptTip = tip;
            organTips.set(id, { tip, rows: raw.bundle.receipts.length });
          }
        }
      } catch (e) {
        record.bootable = null;
        record.driftDetected = null;
        record.reason = `re-derivation threw: ${String(e && e.message ? e.message : e).slice(0, 200)}`;
      }
    } else {
      // meta row exists but the organ bytes are gone/unreadable → store corruption = drift
      record.dialect = null;
      record.bootable = null;
      record.driftDetected = true;
      record.reason = "stored envelope missing or unreadable (meta row without organ bytes)";
    }
    await env.ORGANS.put(`${WATCH_PREFIX}${id}`, JSON.stringify(record));
    checks.push(record);
  }

  // ---- DIVERGENCE DELTA (wave-67): anchored tips vs current tips ----------
  // Runs after the organ sweep so organ_store divergence sources can read the
  // sweep's own re-derived receipt tips (organTips). A tampered ANCHOR row is
  // CORRUPT-ANCHOR (corruption class — the existing disease); a REGRESSED /
  // ADVANCED / MISSING-ANCHOR verdict is DIVERGENCE (two honest states
  // disagreeing — the new disease this delta exists to name).
  let divergence = { lanes: [], divergences: 0, corruptions: 0, checkedAt: null };
  try {
    divergence = await divergenceSweep(env, organTips);
  } catch (e) {
    divergence.error = String(e && e.message ? e.message : e).slice(0, 300);
  }

  const summary = {
    ranAt: new Date().toISOString(),
    trigger,
    durationMs: Date.now() - t0,
    organsTracked: checks.length,
    bootable: checks.filter((c) => c.bootable === true).length,
    drifted: checks.filter((c) => c.driftDetected === true).length,
    indeterminate: checks.filter((c) => c.driftDetected === null).length,
    lanesTracked: divergence.lanes.length,
    divergences: divergence.divergences,
    anchorCorruption: divergence.corruptions,
  };
  await env.ORGANS.put(LAST_RUN_KEY, JSON.stringify(summary));
  return { summary, checks, divergence };
}

async function statusPayload(env) {
  const records = [];
  const divergenceRecords = [];
  let cursor;
  do {
    const page = await env.ORGANS.list({ prefix: WATCH_PREFIX, limit: LIST_PAGE_LIMIT, cursor });
    for (const key of page.keys) {
      if (key.name.startsWith("watch:_")) continue; // _lastRun + _divergence:* are not organs
      const r = await env.ORGANS.get(key.name, { type: "json" }).catch(() => null);
      if (r) records.push(r);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && records.length < MAX_ORGANS);
  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // divergence rows are under watch:_divergence:{lane} — a separate listing so
  // the organs listing above never mixes the two.
  cursor = undefined;
  let dPages = 0;
  do {
    const page = await env.ORGANS.list({ prefix: DIVERGENCE_PREFIX, limit: LIST_PAGE_LIMIT, cursor });
    for (const key of page.keys) {
      const r = await env.ORGANS.get(key.name, { type: "json" }).catch(() => null);
      if (r) divergenceRecords.push(r);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && ++dPages < 16 && divergenceRecords.length < MAX_ORGANS);
  divergenceRecords.sort((a, b) => (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0));

  const lastRun = await env.ORGANS.get(LAST_RUN_KEY, { type: "json" }).catch(() => null);
  const drifted = records.filter((r) => r.driftDetected === true);
  const indeterminate = records.filter((r) => r.driftDetected === null);
  const healthy = records.filter((r) => r.driftDetected === false);
  const divergences = divergenceRecords.filter((r) => r.divergence === true);
  const anchorCorruption = divergenceRecords.filter((r) => r.verdict === "CORRUPT-ANCHOR");
  const fleetHealth = {
    organsTracked: records.length,
    bootable: healthy.length,
    drifted: drifted.length,
    indeterminate: indeterminate.length,
    lanesTracked: divergenceRecords.length,
    divergences: divergences.length,
    anchorCorruption: anchorCorruption.length,
    state:
      records.length === 0 && divergenceRecords.length === 0
        ? "no-checks-yet"
        : divergences.length > 0
          ? "DIVERGENCE-DETECTED"
          : drifted.length > 0 || anchorCorruption.length > 0
            ? "DRIFT-DETECTED"
            : indeterminate.length > 0
              ? "degraded-indeterminate"
              : "healthy",
    lastRun: lastRun ?? null,
  };
  return {
    ok: true,
    service: "organ-watcher",
    loaderUrl: env.LOADER_URL ?? null,
    method: "independent server-side re-derivation of every stored organ's commitments (manifest digest, stateHash, receipt chain, dialect extras) — no code path shared with the loader",
    cadence: "hourly (cron 0 * * * *); POST /check with WORKER_UPLOAD_TOKEN forces a cycle",
    divergenceMethod: "per-lane current tip (GitHub raw chain files / this sweep's re-derived organ tips) vs the notary's anchored history (quilt-tip-notary, same KV) — corruption (re-derivation fails) and divergence (two honest states disagree) are reported as different classes",
    fleetHealth,
    divergence: divergenceRecords,
    organs: records,
  };
}

export default {
  // cron entry — the hourly sweep
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runCycle(env, "cron").catch((e) =>
        env.ORGANS.put(LAST_RUN_KEY, JSON.stringify({ ranAt: new Date().toISOString(), trigger: "cron", error: String(e && e.message ? e.message : e).slice(0, 300) }))
      )
    );
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (method === "GET" && (path === "/" || path === "")) {
      return json({
        service: "organ-watcher",
        ok: true,
        purpose: "fleet boot-readiness monitor + divergence detector: hourly independent re-verification of every organ in the organ-boot-loader store, plus per-lane anchored-tip vs current-tip comparison (quilt-tip-notary)",
        endpoints: {
          "GET /status": "dashboard: last check per organ + per-lane divergence detail + fleet health summary (open)",
          "POST /check": "force one check cycle now (auth: WORKER_UPLOAD_TOKEN)",
        },
        bindings: { ORGANS: "kv_namespace (shared quilt-organ-store: organs + notary anchors + watch rows)", WORKER_UPLOAD_TOKEN: "secret", LOADER_URL: "plain_text (informational)" },
        neverDeletes: "the watcher only writes watch:* rows; organ data and anchor rows are never touched",
      });
    }

    if (method === "GET" && path === "/status") {
      return json(await statusPayload(env));
    }

    if (method === "POST" && path === "/check") {
      if (!(await authOk(request, env))) {
        return fail(401, "unauthorized — present WORKER_UPLOAD_TOKEN via 'Authorization: Bearer <token>' or 'x-quilt-token'");
      }
      const { summary, divergence } = await runCycle(env, "manual");
      return json({ ok: true, forced: true, summary, divergence, dashboard: await statusPayload(env) });
    }

    return fail(404, `no route: ${method} ${path}`);
  },
};
