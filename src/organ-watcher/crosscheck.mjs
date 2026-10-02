/**
 * crosscheck.mjs — the TWO-NOTARY cross-check (wave-68, 68-c).
 *
 * The convergence event: the wave-66 seed-dna census (quilt-atlas 6df5d1d)
 * named tip-anchoring "the missing organ" (3 repos stated the tail-truncation
 * limit; the organ store KV existed unused). TWO agents then built a notary
 * independently within 9 hours — Mavis deployed quilt-tip-anchor at
 * 2026-10-02T08:08:17Z (repo commit 51969e0: chain_id+seq anchors, HMAC-signed,
 * own KV namespace "quilt-tip-anchors"), and our lane 67-a deployed
 * quilt-tip-notary at 16:57:55Z (ea377be: lane+day anchors, content-addressed
 * sha256 re-derived on read, SHARED quilt-organ-store KV). Diversity is the
 * feature; drift is the bug. This module makes the watcher verify against
 * BOTH — two independent witnesses for the same lane — and name the one
 * verdict that matters: NOTARY-DISAGREE (two anchored tips for the same lane
 * that differ = the divergence signal AMPLIFIED, because now the disagreement
 * is between two things that were each written on purpose).
 *
 * Join law: a lane joins across notaries by its NAME (lane id == chain_id in
 * Mavis's store; the identity axes differ — lane/day vs chain_id/seq — and
 * the lane name is the only shared key; receipted in docs/convergence-receipt.md).
 *
 * Integrity model per notary (each witness verified under ITS OWN law, no
 * shared code path — the module restates canonical/sha256 rather than import):
 *   - quilt-tip-notary (OURS): record {lane,day,tip,anchoredAt,prevTipForLane,
 *     note?,sha256} — sha256(canonical(body)) re-derived; mismatch = corrupt.
 *   - quilt-tip-anchor (MAVIS): row {chain_id,tip,seq,at,note,sig} —
 *     sig = HMAC-SHA256(WORKER_UPLOAD_TOKEN, `${chain_id}|${tip}|${seq}|${at}`);
 *     mismatch = sig-unverifiable (write-time token rotated away, OR tampered —
 *     not distinguishable without the key that signed it; fail-closed either
 *     way, and receipted: this is a REAL cost of the HMAC model the
 *     cross-check surfaced — content-addressed anchors survive key rotation,
 *     HMAC-signed ones do not).
 *
 * Per-lane notaries row: [{notary, tip, state, ...}] with state ∈
 *   "anchored" (integrity-verified), "unanchored" (nothing for this lane),
 *   "corrupt" (present but failed its integrity law),
 *   "sig-unverifiable" (HMAC row only; stale key or tampered),
 *   "error" (read/parse failure — recorded, never guessed).
 *
 * Lane-id normalization (wave-69, 69-f): the join assumes lane name ==
 * chain_id, but the two stores name lanes under different laws — fleet canon
 * carries COLONS ("erised-sequencer:anchor-proof", receipted in
 * receipts/TIP-ANCHOR.md: "fleet canon carries a colon by convention"), while
 * OUR notary's lane law (tip-notary/logic.mjs LANE_RE) forbids them, so a
 * colon-carrying chain_id could never be anchored on our side under its own
 * name and the exact-name join could never see it dual-witnessed. The join
 * key is therefore the NORMALIZED id (normalizeLaneId: ":" -> "-", the
 * in-law substitute); raw ids are preserved verbatim in each row's `rawId`
 * and in the record's `rawIds` receipt. Groups with a single raw id keep the
 * raw id as the record's lane (byte-compatible with pre-69f rows); only a
 * real merge (the same lane seen under both namings) publishes the
 * normalized name — and if the two namings carry DIFFERENT tips, that is
 * still NOTARY-DISAGREE (normalization must never hide a fork).
 *
 * Agreement matrix (per lane; fleet = max severity across lanes):
 *   BOTH-MATCH      >= 2 valid anchors, all tips equal
 *   NOTARY-DISAGREE >= 2 valid anchors, tips differ  ← THE ALARM
 *   PARTIAL         exactly 1 valid anchor (single witness; not a fault,
 *                   not yet proof)
 *   NO-ANCHORS      0 valid anchors (even if corrupt/unverifiable rows exist —
 *                   the row detail carries those states, the verdict counts
 *                   only VALID witnesses)
 *
 * Bindings: ORGANS (shared quilt-organ-store — our notary's keys) and ANCHORS
 * (Mavis's quilt-tip-anchors namespace, bound directly; worker→worker HTTP is
 * platform-blocked — receipts/ORGAN-WATCHER.md F1 — so KV is the only road).
 * Nothing is ever deleted; rows are written under watch:_notaries:{lane}.
 */

import { LANE_CONFIG } from "./divergence.mjs";

export const NOTARY_OURS = "quilt-tip-notary";
export const NOTARY_MAVIS = "quilt-tip-anchor";

const OURS_ANCHOR_PREFIX = "anchor:";
const OURS_LATEST_PREFIX = "notary-latest:";
const MAVIS_ANCHOR_PREFIX = "anchor:";
const MAVIS_LATEST_PREFIX = "latest:";
const MAVIS_INDEX_PREFIX = "index:";
const NOTARY_ROW_PREFIX = "watch:_notaries:";
const MAX_LANES = 64;

// ---- canonical JSON + sha256 + hmac (restated; standalone for node --test) --

export function canonical(value, _path = "$") {
  if (value === undefined) throw new TypeError(`canonical: undefined at ${_path}`);
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

export async function sha256hex(str) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Mavis's integrity law (src/tip-anchor/worker.js hmacSign). */
export async function hmacSha256Hex(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- per-notary readers ------------------------------------------------------

/** OURS (quilt-tip-notary): ORGANS KV, anchor:{lane}:{day}, content-addressed. */
export async function readNotaryOurs(kv, lane, token = null) {
  void token; // our law needs no key: content-addressed
  let day;
  try {
    day = await kv.get(`${OURS_LATEST_PREFIX}${lane}`);
  } catch (e) {
    return { notary: NOTARY_OURS, state: "error", detail: `KV read failed: ${String(e && e.message ? e.message : e).slice(0, 120)}` };
  }
  if (day === null || day === undefined) return { notary: NOTARY_OURS, state: "unanchored" };
  let raw;
  try {
    raw = await kv.get(`${OURS_ANCHOR_PREFIX}${lane}:${day}`, { type: "json" });
  } catch (e) {
    return { notary: NOTARY_OURS, state: "error", day, detail: `KV read failed: ${String(e && e.message ? e.message : e).slice(0, 120)}` };
  }
  if (!raw) return { notary: NOTARY_OURS, state: "error", day, detail: `latest pointer to ${day} but no record at anchor:${lane}:${day}` };
  const expected = await sha256hex(canonical({
    lane: raw.lane,
    day: raw.day,
    tip: raw.tip,
    anchoredAt: raw.anchoredAt,
    prevTipForLane: raw.prevTipForLane,
    ...(raw.note ? { note: raw.note } : {}),
  })).catch(() => null);
  if (!expected || raw.sha256 !== expected) {
    return { notary: NOTARY_OURS, state: "corrupt", day, tip: raw.tip ?? null, detail: "sha256 re-derivation failed — anchor record tampered or written by a foreign law" };
  }
  return { notary: NOTARY_OURS, state: "anchored", tip: raw.tip, day, anchoredAt: raw.anchoredAt };
}

/**
 * The cross-notary join key: fleet-canon colons mapped into OUR notary's lane
 * alphabet (LANE_RE allows [a-z0-9_-]). Pure and conservative: only ":" is
 * rewritten (the one receipted divergence between the namings); everything
 * else passes through untouched. Exported for node --test.
 */
export function normalizeLaneId(id) {
  if (typeof id !== "string") throw new TypeError(`normalizeLaneId: expected string, got ${typeof id}`);
  return id.trim().replace(/:/g, "-");
}

/** MAVIS (quilt-tip-anchor): ANCHORS KV, latest:{chain_id} -> anchor:{chain_id}:{seq}, HMAC-signed. */
export async function readNotaryMavis(kv, chainId, token) {
  let latestSeq;
  try {
    latestSeq = await kv.get(`${MAVIS_LATEST_PREFIX}${chainId}`);
  } catch (e) {
    return { notary: NOTARY_MAVIS, state: "error", detail: `KV read failed: ${String(e && e.message ? e.message : e).slice(0, 120)}` };
  }
  if (latestSeq === null || latestSeq === undefined) return { notary: NOTARY_MAVIS, state: "unanchored" };
  let raw;
  try {
    raw = await kv.get(`${MAVIS_ANCHOR_PREFIX}${chainId}:${latestSeq}`, { type: "json" });
  } catch (e) {
    return { notary: NOTARY_MAVIS, state: "error", seq: latestSeq, detail: `KV read failed: ${String(e && e.message ? e.message : e).slice(0, 120)}` };
  }
  if (!raw) return { notary: NOTARY_MAVIS, state: "error", seq: latestSeq, detail: `latest pointer to seq ${latestSeq} but no row at anchor:${chainId}:${latestSeq}` };
  if (typeof token !== "string" || token === "") {
    return { notary: NOTARY_MAVIS, state: "error", tip: raw.tip ?? null, seq: raw.seq ?? null, detail: "cannot verify HMAC sig: WORKER_UPLOAD_TOKEN not bound" };
  }
  const expected = await hmacSha256Hex(token, `${chainId}|${raw.tip}|${raw.seq}|${raw.at}`).catch(() => null);
  if (!expected || raw.sig !== expected) {
    return {
      notary: NOTARY_MAVIS,
      state: "sig-unverifiable",
      tip: raw.tip ?? null,
      seq: raw.seq ?? null,
      at: raw.at ?? null,
      detail: "HMAC sig does not verify under the CURRENT shared token — written under an earlier key (rotation) or tampered; not distinguishable without the write-time key, fail-closed either way",
    };
  }
  return { notary: NOTARY_MAVIS, state: "anchored", tip: raw.tip, seq: raw.seq, at: raw.at };
}

// ---- the agreement verdict (pure) --------------------------------------------

/**
 * rows: per-notary rows as produced by the readers. Valid witness = state
 * "anchored" (tip present). Verdict per the matrix in the header.
 */
export function agreementVerdict(rows) {
  const valid = rows.filter((r) => r && r.state === "anchored" && typeof r.tip === "string");
  const flawed = rows.filter((r) => r && (r.state === "corrupt" || r.state === "sig-unverifiable" || r.state === "error"));
  if (valid.length >= 2) {
    const tips = new Set(valid.map((r) => r.tip));
    if (tips.size === 1) {
      return { notaryAgreement: "BOTH-MATCH", divergence: false, reason: `${valid.length} independent notaries anchored the same tip ${valid[0].tip} — dual-witnessed` };
    }
    return {
      notaryAgreement: "NOTARY-DISAGREE",
      divergence: true,
      reason: `notaries anchored DIFFERENT tips for the same lane: ${valid.map((r) => `${r.notary}=${r.tip}`).join(" vs ")} — two chosen scars disagree; treat the lane's chain as suspected fork/truncation until a human arbitrates`,
    };
  }
  if (valid.length === 1) {
    return {
      notaryAgreement: "PARTIAL",
      divergence: false,
      reason: `single witness (${valid[0].notary}) — dual coverage not yet reached${flawed.length ? `; other notary rows flawed: ${flawed.map((r) => `${r.notary}:${r.state}`).join(", ")}` : ""}`,
    };
  }
  return {
    notaryAgreement: "NO-ANCHORS",
    divergence: false,
    reason: flawed.length
      ? `no VALID anchor: ${flawed.map((r) => `${r.notary}:${r.state}`).join(", ")} — witnesses present but fail their integrity law; re-anchor or investigate`
      : "no notary has anchored this lane",
  };
}

// ---- the sweep (KV over both namespaces; used by the watcher's cycle) --------

/** Full cross-check sweep. Returns rows + fleet summary; caller persists. */
export async function crossCheckSweep(env) {
  const checkedAt = new Date().toISOString();
  const oursKv = env.ORGANS;
  const mavisKv = env.ANCHORS;

  // raw lane ids = ours(notary-latest:*) ∪ LANE_CONFIG keys, and mavis(index:*)
  const oursRaw = new Set(Object.keys(LANE_CONFIG));
  if (oursKv) {
    let cursor;
    do {
      const page = await oursKv.list({ prefix: OURS_LATEST_PREFIX, limit: 1000, cursor });
      for (const k of page.keys) oursRaw.add(k.name.slice(OURS_LATEST_PREFIX.length));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor && oursRaw.size < MAX_LANES);
  }
  const mavisRaw = new Set();
  if (mavisKv) {
    let cursor;
    do {
      const page = await mavisKv.list({ prefix: MAVIS_INDEX_PREFIX, limit: 1000, cursor });
      for (const k of page.keys) mavisRaw.add(k.name.slice(MAVIS_INDEX_PREFIX.length));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor && mavisRaw.size < MAX_LANES);
  }

  // group raw ids by the NORMALIZED join key (69-f): colon-carrying fleet-canon
  // names and their in-law dash spellings are the SAME lane; each row keeps its
  // rawId so nothing is guessed about which spelling carried which witness.
  const groups = new Map(); // normKey -> { ours: Set, mavis: Set, order }
  const groupFor = (rawId, side) => {
    const key = normalizeLaneId(rawId);
    if (!groups.has(key)) groups.set(key, { ours: new Set(), mavis: new Set() });
    groups.get(key)[side].add(rawId);
    return key;
  };
  const laneList = [];
  for (const raw of oursRaw) { const k = groupFor(raw, "ours"); if (!laneList.includes(k)) laneList.push(k); }
  for (const raw of mavisRaw) { const k = groupFor(raw, "mavis"); if (!laneList.includes(k)) laneList.push(k); }
  const groupKeys = laneList.slice(0, MAX_LANES);

  const out = [];
  let disagreements = 0;
  let bothMatches = 0;
  let partials = 0;
  let noAnchors = 0;
  let flawedRows = 0;

  for (const normKey of groupKeys) {
    const g = groups.get(normKey);
    const mavisIds = [...g.mavis].sort();
    const oursIds = [...g.ours].sort();

    // Each witness read from its OWN store under ITS OWN law, at its raw id.
    // A notary with no raw spelling in the group contributes one explicit
    // "unanchored" row at the normalized spelling — the pair-shaped record is
    // kept (both reads receipted), and the index/notary-latest listings are
    // the complete universe of each store's anchored lanes, so a spelling
    // absent from the listing provably has no anchor row to read.
    const mavisRows = [];
    if (mavisKv) {
      for (const rawId of mavisIds) {
        const r = await readNotaryMavis(mavisKv, rawId, env.WORKER_UPLOAD_TOKEN);
        mavisRows.push({ ...r, rawId });
      }
      if (!mavisIds.length) mavisRows.push({ notary: NOTARY_MAVIS, state: "unanchored", rawId: normKey });
    } else {
      mavisRows.push({ notary: NOTARY_MAVIS, state: "error", detail: "ANCHORS KV namespace not bound to this watcher" });
    }
    const oursRows = [];
    if (oursKv) {
      for (const rawId of oursIds) {
        const r = await readNotaryOurs(oursKv, rawId);
        oursRows.push({ ...r, rawId });
      }
      if (!oursIds.length) oursRows.push({ notary: NOTARY_OURS, state: "unanchored", rawId: normKey });
    } else {
      oursRows.push({ notary: NOTARY_OURS, state: "error", detail: "ORGANS KV namespace not bound to this watcher" });
    }
    const rows = [...mavisRows, ...oursRows];

    const v = agreementVerdict(rows);
    if (v.notaryAgreement === "NOTARY-DISAGREE") disagreements += 1;
    else if (v.notaryAgreement === "BOTH-MATCH") bothMatches += 1;
    else if (v.notaryAgreement === "PARTIAL") partials += 1;
    else noAnchors += 1;
    flawedRows += rows.filter((r) => r.state === "corrupt" || r.state === "sig-unverifiable" || r.state === "error").length;

    // One distinct spelling (both sides using the same name) keeps the raw
    // name — byte-compatible with pre-69f rows. A REAL merge (the same lane
    // under both namings) publishes the normalized join key, rawIds receipted.
    const spellings = [...new Set([...mavisIds, ...oursIds])];
    const lane = spellings.length === 1 ? spellings[0] : normKey;
    const record = {
      lane,
      checkedAt,
      ...(spellings.length > 1 ? { rawIds: { [NOTARY_MAVIS]: mavisIds, [NOTARY_OURS]: oursIds } } : {}),
      notaries: rows,
      notaryAgreement: v.notaryAgreement,
      divergence: v.divergence,
      reason: v.reason,
    };
    // Persist under the lane name AND every raw spelling in the group — a
    // pre-69f row keyed by the colon spelling is superseded in place (the
    // watcher's own derived view, rewritten every cycle; never a data row).
    const persistKeys = new Set([lane, ...spellings]);
    for (const key of persistKeys) {
      await oursKv.put(`${NOTARY_ROW_PREFIX}${key}`, JSON.stringify(record));
    }
    out.push(record);
  }

  // fleet-level verdict: max severity (disagree > both-match > partial > no-anchors)
  const notaryAgreement =
    disagreements > 0 ? "NOTARY-DISAGREE"
    : bothMatches > 0 ? "BOTH-MATCH"
    : partials > 0 ? "PARTIAL"
    : "NO-ANCHORS";

  return {
    lanes: out,
    notaryAgreement,
    summary: {
      lanesChecked: out.length,
      disagreements,
      bothMatches,
      partials,
      noAnchors,
      flawedRows,
      checkedAt,
    },
  };
}

/** Rehydrate persisted notary rows for /status. Since 69f a lane's record may
 * sit under MORE than one key (the lane name + each raw spelling, so a
 * pre-69f row is superseded in place); dedupe by `lane`, keeping the freshest
 * checkedAt, so fleetHealth counts lanes, not key spellings. */
export async function loadNotaryRows(kv) {
  const rows = [];
  let cursor;
  let pages = 0;
  do {
    const page = await kv.list({ prefix: NOTARY_ROW_PREFIX, limit: 1000, cursor });
    for (const key of page.keys) {
      const r = await kv.get(key.name, { type: "json" }).catch(() => null);
      if (r) rows.push(r);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && ++pages < 16 && rows.length < 512);
  rows.sort((a, b) => (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0));
  const deduped = [];
  for (const r of rows) {
    const prev = deduped.find((x) => x.lane === r.lane);
    if (!prev) deduped.push(r);
    else if (String(r.checkedAt ?? "") > String(prev.checkedAt ?? "")) deduped[deduped.indexOf(prev)] = r;
  }
  return deduped;
}

export function fleetAgreement(notaryRows) {
  const sev = (r) => (r.notaryAgreement === "NOTARY-DISAGREE" ? 3 : r.notaryAgreement === "BOTH-MATCH" ? 2 : r.notaryAgreement === "PARTIAL" ? 1 : 0);
  const max = notaryRows.reduce((m, r) => Math.max(m, sev(r)), -1);
  return max < 0 ? null : ["NO-ANCHORS", "PARTIAL", "BOTH-MATCH", "NOTARY-DISAGREE"][max];
}
