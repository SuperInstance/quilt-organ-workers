/**
 * logic.mjs — pure law for quilt-tip-notary (wave-67, mission 67-a).
 *
 * Imported by BOTH the worker (src/tip-notary/worker.js, Cloudflare Workers
 * runtime) and the node --test suite (tests/tip-notary.test.mjs, stdlib).
 * crypto.subtle is a global in Workers and in Node >= 15, so no imports are
 * needed — the module is runtime-agnostic by construction.
 *
 * The notary's law, in one place:
 *   - a lane id is 1..64 chars of [a-z0-9_-], starting alnum        (E_LANE_FORMAT)
 *   - a day is a REAL calendar date in UTC, "YYYY-MM-DD"            (E_DAY_FORMAT)
 *   - a tip is 32 bytes as 64 lowercase hex chars                   (E_TIP_FORMAT)
 *   - a note is optional, a string, <= 512 chars                    (E_NOTE_FORMAT)
 *   - no fields beyond the known set                                (E_UNKNOWN_FIELD)
 *   - a record's integrity is content-addressed: sha256hex(canonical(body))
 *     over the exact field set {anchoredAt, day, lane, note, prevTipForLane, tip}
 *     (note omitted when empty), stored AS the record's `sha256` field and
 *     re-derived on every read. A record that fails re-derivation is answered
 *     E_INTEGRITY (fail-closed) — a tampered anchor row is corruption, named.
 *   - per-lane chaining: every anchor records `prevTipForLane` = the tip of the
 *     lane's most recent anchor on an EARLIER day (null for the lane's first
 *     anchor). The anchored tips therefore form a scar chain outside the
 *     patient: tail truncation of the lane's real chain shows up as a
 *     regression against this history (the watcher's job to compare).
 *
 * Canonical JSON = recursive key-sorted, no whitespace, fail-closed on
 * undefined / non-finite numbers / bigint / function / symbol — byte-identical
 * to the fleet's other canonical() implementations (toolkit, boot-loader,
 * organ-watcher, qmr1 DESIGN.md §2).
 */

export const TIP_RE = /^[a-f0-9]{64}$/;
export const LANE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const NOTE_MAX = 512;

export function canonical(value, _path = "$") {
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

export async function sha256hex(str) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** "YYYY-MM-DD" that is not just shaped but a REAL UTC calendar date. */
export function isRealDay(day) {
  if (typeof day !== "string" || !DAY_RE.test(day)) return false;
  const [y, m, d] = day.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

/** The canonical body over which a record's sha256 is derived. */
export function anchorBody({ lane, day, tip, anchoredAt, prevTipForLane, note }) {
  const body = { lane, day, tip, anchoredAt, prevTipForLane };
  if (note !== undefined && note !== null && note !== "") body.note = note;
  return body;
}

/** Content address of a record (the value stored in its `sha256` field). */
export async function anchorSha256(record) {
  return sha256hex(canonical(anchorBody(record)));
}

/**
 * Validate a POST /anchor body. Returns { value } or { error, detail }.
 * Fail-closed and NAMED: E_BODY_FORMAT, E_LANE_FORMAT, E_DAY_FORMAT,
 * E_TIP_FORMAT, E_NOTE_FORMAT, E_UNKNOWN_FIELD.
 */
export function validateAnchorInput(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "E_BODY_FORMAT", detail: "body must be a JSON object" };
  }
  const known = new Set(["lane", "day", "tip", "note"]);
  for (const k of Object.keys(body)) {
    if (!known.has(k)) return { error: "E_UNKNOWN_FIELD", detail: `unknown field "${k}" (known: lane, day, tip, note?)` };
  }
  const { lane, day, tip, note } = body;
  if (typeof lane !== "string" || !LANE_RE.test(lane)) {
    return { error: "E_LANE_FORMAT", detail: "lane must match ^[a-z0-9][a-z0-9_-]{0,63}$" };
  }
  if (!isRealDay(day)) {
    return { error: "E_DAY_FORMAT", detail: "day must be a real UTC calendar date, YYYY-MM-DD" };
  }
  if (typeof tip !== "string" || !TIP_RE.test(tip)) {
    return { error: "E_TIP_FORMAT", detail: "tip must be 32 bytes as 64 lowercase hex chars" };
  }
  if (note !== undefined && (typeof note !== "string" || note.length > NOTE_MAX)) {
    return { error: "E_NOTE_FORMAT", detail: `note must be a string of at most ${NOTE_MAX} chars` };
  }
  return { value: { lane, day, tip, note: note ?? "" } };
}

/**
 * Which tip is `prevTipForLane` for an anchor at `day`? Pure: takes the lane's
 * existing records (any order), picks the tip of the record with the greatest
 * day STRICTLY LESS than the new day; null when the lane has none (first
 * anchor). Days are ISO dates, so lexicographic order == chronological order.
 */
export function selectPrevTip(records, day) {
  let best = null;
  for (const r of records) {
    if (!r || typeof r.day !== "string" || typeof r.tip !== "string") continue;
    if (r.day < day && (best === null || r.day > best.day)) best = r;
  }
  return best === null ? null : best.tip;
}
