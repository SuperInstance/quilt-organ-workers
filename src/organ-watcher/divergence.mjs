/**
 * divergence.mjs — the organ-watcher's divergence delta (wave-67, 67-a).
 *
 * The watcher's EXISTING job is corruption: re-derive every stored organ's
 * commitments; a chain that no longer re-derives is DRIFT-DETECTED (named,
 * fail-closed). What corruption-detection CANNOT see is a store whose chain
 * re-derives perfectly but disagrees with what it used to be — tail
 * truncation, a fork, a stale anchor. Wave-66 converged on the cure from
 * three directions (quilt-atlas seed-dna census 6df5d1d: three repos state
 * the tail-truncation limit; erised-fleet-table quest-log: "an anchor is a
 * scar you choose in advance"; qmr1 DESIGN.md §5: "truncation is a detectable
 * count/tip regression against the anchor"): anchor tips OUTSIDE the patient,
 * then compare. The outside is quilt-tip-notary (src/tip-notary), in the SAME
 * KV namespace (quilt-organ-store) — read here directly over the ORGANS
 * binding, because worker→worker HTTP is platform-blocked
 * (receipts/ORGAN-WATCHER.md F1).
 *
 * After every hourly cycle (and POST /check), for each lane with anchored
 * tips ∪ each configured lane:
 *   1. load the lane's anchored history from the notary's KV keys
 *      (anchor:{lane}:{day}), re-deriving every record's content address —
 *      a record that fails re-derivation is CORRUPT-ANCHOR (the EXISTING
 *      disease class: corruption), fail-closed, never silenced;
 *   2. derive the lane's CURRENT tip from its configured source (today: the
 *      chain's home on GitHub raw, re-derived from genesis by the watcher
 *      itself; organ_store sources read the sweep's own re-derived receipt
 *      tips);
 *   3. verdict:
 *        MATCH           current tip == latest anchored tip
 *        REGRESSED       current tip equals an EARLIER anchored tip — the
 *                        chain went backwards: the tail-truncation signature
 *                        the three repos named (divergence class)
 *        ADVANCED        current tip is in no anchored history — the store
 *                        moved past the last anchor, or a fork exists (a
 *                        different file whose tip differs) (divergence class)
 *        MISSING-ANCHOR  the lane has a derivable current tip but never
 *                        anchored (divergence class)
 *        CORRUPT-ANCHOR  an anchored record failed its sha256 re-derivation
 *                        (corruption class)
 *        INDETERMINATE   source unreachable or unconfigured — recorded, never
 *                        guessed
 *   4. any divergence-class verdict flips fleetHealth.state to
 *      DIVERGENCE-DETECTED in GET /status, with per-lane detail.
 *
 * Two honest states disagreeing is a DIFFERENT disease from bytes failing
 * re-derivation — that distinction is the whole point of this delta.
 *
 * LANE_CONFIG is code-registered for wave-67 (adding a lane = one config line
 * + redeploy; a KV-driven registry is the next lane's soft joint). Sources:
 *   - github_raw: fetch https://raw.githubusercontent.com/{repo}/{branch}/{path}
 *     and re-derive the tip under the lane's dialect law (below, stdlib-only).
 *   - organ_store: tip already re-derived from the organ sweep (organTips).
 *
 * Dialect laws re-implemented here (the watcher shares NO code path with the
 * watched — qmr1 DESIGN.md §2 and erised-sequencer engine.mjs are the specs):
 *   qmr1:          id = sha256("qmr1:" + seq + ":" + prev + ":" + canonicalJSON(body)),
 *                  genesis prev = "0"×64, seqs 1..n, tip = last id.
 *   erised-ledger: row tip = sha256(seq + "|" + op + "|" + canon(payload) + "|"
 *                  + prev + "|" + sticky), canon = top-level key-sorted
 *                  stringify, prev starts "genesis", tip = last row tip.
 */

export const LANE_CONFIG = {
  qmr1: {
    source: "github_raw",
    repo: "SuperInstance/erised-fleet-table",
    branch: "main",
    path: "ledger/fleet-snapshot/receipt-chain.jsonl",
    dialect: "qmr1",
    note: "quilt-mcp-receipts' store.jsonl is a runtime file (not committed to that repo); the live qmr1 chain reachable via GitHub raw is the 5-receipt snapshot vendored by erised-fleet-table (wave-66 66-d). Tip re-derived per qmr1 DESIGN.md §2.",
  },
  "erised-ft1": {
    source: "github_raw",
    repo: "SuperInstance/erised-fleet-table",
    branch: "main",
    path: "ledger/session.json",
    dialect: "erised-ledger",
    note: "erised-fleet-table's 73-receipt session ledger; tip re-derived per erised-sequencer engine.mjs (and cross-checked against the file's own verify.tip).",
  },
};

const ANCHOR_PREFIX = "anchor:";
const LATEST_PREFIX = "notary-latest:";
const DIVERGENCE_PREFIX = "watch:_divergence:";
const MAX_LANES = 64;
const MAX_ANCHORS_PER_LANE = 1000;
const FETCH_TIMEOUT_MS = 15000;

// ---- canonical JSON + sha256 (the fleet law, re-stated here so this module
// ---- stays standalone for node --test; byte-identical to the watcher's own)

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
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- dialect derivations (pure; exported for node --test) ------------------

/** qmr1 (quilt-mcp-receipts DESIGN.md §2): returns {ok, tip, rows} or {ok:false, reason}. */
export async function deriveQmr1Tip(text) {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return { ok: false, reason: "qmr1 store is empty" };
  const GENESIS = "0".repeat(64);
  let prev = GENESIS;
  let tip = null;
  for (let i = 0; i < lines.length; i++) {
    let r;
    try {
      r = JSON.parse(lines[i]);
    } catch {
      return { ok: false, reason: `qmr1 line ${i + 1} is not valid JSON (E_STORE_CORRUPT class)` };
    }
    if (r.seq !== i + 1) return { ok: false, reason: `qmr1 line ${i + 1}: seq ${r.seq} != ${i + 1} (E_SEQ_MISMATCH class)` };
    if (r.prev !== prev) return { ok: false, reason: `qmr1 line ${i + 1}: prev does not link (E_PREV_MISMATCH class)` };
    const id = await sha256hex("qmr1:" + r.seq + ":" + r.prev + ":" + canonical(r.body));
    if (id !== r.id) return { ok: false, reason: `qmr1 line ${i + 1}: id mismatch (E_HASH_MISMATCH class)` };
    prev = id;
    tip = id;
  }
  return { ok: true, tip, rows: lines.length };
}

/** erised-ledger (erised-sequencer engine.mjs): returns {ok, tip, rows} or {ok:false, reason}. */
export async function deriveErisedTip(text) {
  let session;
  try {
    session = JSON.parse(text);
  } catch {
    return { ok: false, reason: "erised session.json is not valid JSON" };
  }
  const ops = session?.ops;
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, reason: "erised session has no ops" };
  const ecanon = (o) => JSON.stringify(o, Object.keys(o).sort());
  let prev = "genesis";
  for (let i = 0; i < ops.length; i++) {
    const row = ops[i];
    if (row.seq !== i + 1) return { ok: false, reason: `erised row ${i + 1}: seq mismatch` };
    if (row.prev !== prev) return { ok: false, reason: `erised row ${i + 1}: prev does not link` };
    const t = await sha256hex(`${row.seq}|${row.op}|${ecanon(row.payload)}|${row.prev}|${row.sticky}`);
    if (t !== row.tip) return { ok: false, reason: `erised row ${i + 1}: tip mismatch (E_HASH_MISMATCH class)` };
    prev = row.tip;
  }
  if (session.verify && typeof session.verify.tip === "string" && session.verify.tip !== prev) {
    return { ok: false, reason: "erised session's own verify.tip disagrees with the re-derived tip (fork/corruption signature)" };
  }
  return { ok: true, tip: prev, rows: ops.length };
}

export async function deriveTipForDialect(dialect, text) {
  if (dialect === "qmr1") return deriveQmr1Tip(text);
  if (dialect === "erised-ledger") return deriveErisedTip(text);
  return { ok: false, reason: `unknown dialect "${dialect}"` };
}

// ---- verdict (pure; exported for node --test) -------------------------------

/**
 * history: [{day, tip}] oldest-first, each integrity-checked by the caller.
 * current: {ok:true, tip, rows?} | {ok:false, reason}.
 */
export function divergenceVerdict({ history, current }) {
  if (!current || !current.ok) {
    return { verdict: "INDETERMINATE", divergence: false, reason: current?.reason ?? "current tip unavailable" };
  }
  if (!Array.isArray(history) || history.length === 0) {
    return {
      verdict: "MISSING-ANCHOR",
      divergence: true,
      reason: "lane has a derivable current tip but no anchored tip — anchor it (an anchor is a scar you choose in advance)",
    };
  }
  const latest = history[history.length - 1];
  if (latest.tip === current.tip) return { verdict: "MATCH", divergence: false };
  const earlier = history.find((a) => a.tip === current.tip);
  if (earlier) {
    return {
      verdict: "REGRESSED",
      divergence: true,
      reason: `current tip equals the anchor of day ${earlier.day} — the chain went BACKWARDS since then (tail-truncation signature)`,
    };
  }
  return {
    verdict: "ADVANCED",
    divergence: true,
    reason: "current tip is in no anchored history — the store moved past the last anchor (stale anchor) or a fork exists (a different file whose tip differs)",
  };
}

// ---- the sweep (KV + fetch; used by the watcher's cycle) --------------------

async function fetchCurrentTip(laneConfig) {
  if (laneConfig.source === "github_raw") {
    const url = `https://raw.githubusercontent.com/${laneConfig.repo}/${laneConfig.branch}/${laneConfig.path}`;
    let resp;
    try {
      resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (e) {
      return { ok: false, reason: `fetch failed: ${String(e && e.message ? e.message : e).slice(0, 120)}` };
    }
    if (!resp.ok) return { ok: false, reason: `raw fetch HTTP ${resp.status} for ${url}` };
    const text = await resp.text();
    const derived = await deriveTipForDialect(laneConfig.dialect, text);
    return { ...derived, sourceUrl: url };
  }
  return { ok: false, reason: `unsupported source "${laneConfig.source}"` };
}

/** All anchored records for one lane, oldest first, each integrity-checked. */
async function anchoredHistory(env, lane) {
  const keys = [];
  let cursor;
  do {
    const page = await env.ORGANS.list({ prefix: `${ANCHOR_PREFIX}${lane}:`, limit: 1000, cursor });
    for (const k of page.keys) keys.push(k.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && keys.length < MAX_ANCHORS_PER_LANE);
  const history = [];
  const corrupt = [];
  for (const key of keys.slice(0, MAX_ANCHORS_PER_LANE)) {
    const raw = await env.ORGANS.get(key, { type: "json" }).catch(() => null);
    if (!raw) continue;
    const expected = await sha256hex(canonical({
      lane: raw.lane,
      day: raw.day,
      tip: raw.tip,
      anchoredAt: raw.anchoredAt,
      prevTipForLane: raw.prevTipForLane,
      ...(raw.note ? { note: raw.note } : {}),
    })).catch(() => null);
    if (!expected || raw.sha256 !== expected) {
      corrupt.push({ key, day: raw.day ?? null, stored: raw.sha256 ?? null, expected });
      continue;
    }
    history.push({ day: raw.day, tip: raw.tip });
  }
  history.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return { history, corrupt };
}

/**
 * One divergence sweep. organTips: Map(organId -> {tip, rows}) from the
 * organ sweep that just ran (organ_store sources read from it). Returns
 * { lanes: [per-lane records], divergences, corruptions } — the caller
 * persists per-lane rows and the summary.
 */
export async function divergenceSweep(env, organTips = new Map()) {
  const checkedAt = new Date().toISOString();

  // lanes = KV-tracked (notary-latest:*) ∪ LANE_CONFIG
  const kvLanes = [];
  let cursor;
  do {
    const page = await env.ORGANS.list({ prefix: LATEST_PREFIX, limit: 1000, cursor });
    for (const k of page.keys) kvLanes.push(k.name.slice(LATEST_PREFIX.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && kvLanes.length < MAX_LANES);
  const lanes = [...new Set([...kvLanes, ...Object.keys(LANE_CONFIG)])].slice(0, MAX_LANES);

  const out = [];
  let divergences = 0;
  let corruptions = 0;

  for (const lane of lanes) {
    const cfg = LANE_CONFIG[lane] ?? null;
    const { history, corrupt } = await anchoredHistory(env, lane);

    let record;
    if (corrupt.length > 0) {
      corruptions += 1;
      record = {
        lane,
        verdict: "CORRUPT-ANCHOR",
        divergence: false,
        class: "corruption",
        checkedAt,
        corruptAnchors: corrupt,
        reason: "anchored record(s) failed sha256 re-derivation — corruption of the anchor itself (existing disease class), fail-closed",
      };
    } else {
      let current;
      if (cfg) {
        current = await fetchCurrentTip(cfg);
      } else if (cfg === null && organTips instanceof Map && organTips.size > 0 && organTips.has(lane)) {
        const ot = organTips.get(lane);
        current = { ok: true, tip: ot.tip, rows: ot.rows, sourceUrl: `organ-store:${lane}` };
      } else {
        current = { ok: false, reason: "lane has anchored tips but no current-tip source (add it to LANE_CONFIG or upload its chain as an organ)" };
      }
      const v = divergenceVerdict({ history, current });
      if (v.divergence) divergences += 1;
      record = {
        lane,
        verdict: v.verdict,
        divergence: v.divergence,
        class: v.divergence ? "divergence" : null,
        checkedAt,
        anchoredTip: history.length ? history[history.length - 1].tip : null,
        anchoredDay: history.length ? history[history.length - 1].day : null,
        historyDays: history.map((h) => h.day),
        currentTip: current.ok ? current.tip : null,
        currentRows: current.ok && typeof current.rows === "number" ? current.rows : null,
        currentSource: cfg ? `${cfg.source}:${cfg.repo}/${cfg.branch}/${cfg.path}` : current.sourceUrl ?? null,
        dialect: cfg?.dialect ?? null,
        reason: v.reason ?? null,
      };
    }
    await env.ORGANS.put(`${DIVERGENCE_PREFIX}${lane}`, JSON.stringify(record));
    out.push(record);
  }

  return { lanes: out, divergences, corruptions, checkedAt };
}
