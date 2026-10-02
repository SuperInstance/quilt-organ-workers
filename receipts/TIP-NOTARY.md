# tip-notary — deployment + dogfood receipt (wave-67, 67-a)

**Worker:** `quilt-tip-notary` → https://quilt-tip-notary.casey-digennaro.workers.dev
**Deployed:** 2026-10-02T16:57:55Z (REST upload, no wrangler; `scripts/deploy-tip-notary.sh`
and section 5 of `scripts/deploy.sh`; 2-MODULE bundle `worker.js` + `logic.mjs`)
**KV:** the SHARED `quilt-organ-store` namespace `cd5a5b7efdaf436287a916230262d726`
(binding `ORGANS`) — keys `anchor:{lane}:{day}` and `notary-latest:{lane}`,
prefixes disjoint from the loader's `meta:`/`organ:*` and the watcher's `watch:*`.
**Secret:** `WORKER_UPLOAD_TOKEN` attached at upload as secret_text; value only in
gitignored `.env.keys`. The shared fleet token was REGENERATED this wave (the prior
value was unrecoverable — write-only secret, absent from `.env.keys` at wave start)
and re-attached to all four workers so the one-token convention holds; live-proven
by an idempotent re-PUT of the canonical fixture to the boot-loader with the rotated
token (200, same organId `677a3c79…`, no new store data) and 401s on bad tokens.

## Why

Wave-66's seed-dna census (quilt-atlas 6df5d1d) found three repos (quilt-nn,
quilt-qcells, slackwater-quilt) stating the same honest limit: bare hash chains
cannot detect tail truncation without an anchored tip. qmr1 DESIGN.md §5 says it
verbatim: "v2 anchors the tip externally — e.g. periodic tip commit into a git ref
or the organ-workers KV store; then truncation is a detectable count/tip regression
against the anchor." The erised-fleet-table quest-log converged independently:
"an anchor is a scar you choose in advance." This worker is that anchor; the
sibling `quilt-tip-anchor` (wave 66, chain_id/seq witness, own namespace) is left
untouched — belt-and-suspenders, different scopes.

## Law

- POST /anchor {lane, day, tip, note?} → record {lane, day, tip, anchoredAt,
  prevTipForLane, note?, sha256} at KV key `anchor:{lane}:{day}`; per-lane chaining
  (`prevTipForLane` = tip of the lane's most recent anchor on an earlier day);
  `notary-latest:{lane}` pointer. Same {lane,day,tip} re-POST → 200 idempotent;
  same day with a different tip → 409 `E_DAY_CONFLICT` (a chosen scar is never
  overwritten). Rows are never deleted.
- Content-addressed integrity: record.sha256 = sha256(canonicalJSON(body)) over
  {anchoredAt, day, lane, note, prevTipForLane, tip} (note omitted when empty),
  re-derived on EVERY read; failure → 500 `E_INTEGRITY`, fail-closed.
- Fail-closed named errors: `E_BODY_FORMAT`, `E_LANE_FORMAT` (^[a-z0-9][a-z0-9_-]{0,63}$),
  `E_DAY_FORMAT` (REAL UTC calendar date — 2026-02-30 rejected), `E_TIP_FORMAT`
  (64 lowercase hex), `E_NOTE_FORMAT` (≤512), `E_UNKNOWN_FIELD`, `E_DAY_CONFLICT`,
  `E_LANE_UNANCHORED`, `E_NOT_ANCHORED`, `E_INTEGRITY`, `E_UNAUTHORIZED`.
- GETs are public and CORS-open: /anchor/{lane}/{day}, /anchor/{lane} (history),
  /latest/{lane}, /status {lanesTracked, lanes[...], healthy}, /health.

## Live test (2026-10-02T16:58–17:02Z)

| probe | result |
|---|---|
| GET /health, GET / | 200 service index, neverDeletes true |
| POST /anchor selftest (lane `z-67a-selftest`, tip `07875630…`) | 201, record content-addressed, prevTipForLane null |
| GET /anchor/z-67a-selftest/2026-10-02 | 200, integrity "ok" |
| POST without token / bad token | 401 `E_UNAUTHORIZED` |
| POST bad tip / bad day (2026-02-30) / bad lane / unknown field | 400 `E_TIP_FORMAT` / `E_DAY_FORMAT` / `E_LANE_FORMAT` / `E_UNKNOWN_FIELD` |
| POST same day different tip | 409 `E_DAY_CONFLICT` |
| POST same {lane,day,tip} | 200 idempotent |
| **TAMPER-CHECK** (KV REST write behind the worker's back, then repair) | tampered row → GET 500 `E_INTEGRITY` → restored honest bytes → GET 200 integrity ok. The row remains (never-delete-data); the tamper itself is this receipt's record. |
| GET /status | lanesTracked tracked, healthy true, integrity ok per lane |

**Finding (tooling, receipted):** canonical JSON is JSON.stringify semantics —
raw non-ASCII, minimal escapes. Python's `json.dumps` default (`ensure_ascii=True`)
escapes `—` to `\u2014` and produces a DIFFERENT content address. Tooling that
re-derives fleet canonical hashes must use `ensure_ascii=False, sort_keys=True,
separators=(',',':')` (or node with the fleet `canonical()`). The worker's law is
byte-identical with the toolkit, the loader, the watcher, and qmr1 §2.

## Watcher divergence delta (same wave)

`src/organ-watcher/divergence.mjs` — after every cycle the watcher re-derives each
lane's CURRENT tip (qmr1: sha256("qmr1:"+seq+":"+prev+":"+canon(body)) chain from
genesis over the raw store; erised-ft1: sha256(seq|op|canon(payload)|prev|sticky)
chain; organ_store sources: the sweep's own re-derived receipt tips) and compares
against the notary's anchored history. Verdicts: MATCH · REGRESSED (current tip
equals an EARLIER anchored tip — tail truncation signature) · ADVANCED (tip in no
anchored history — stale anchor or fork) · MISSING-ANCHOR · CORRUPT-ANCHOR
(anchor row fails sha256 — corruption class, never conflated with divergence) ·
INDETERMINATE (source down — recorded, never guessed). Any divergence flips
`fleetHealth.state` to `DIVERGENCE-DETECTED`; per-lane detail at
`watch:_divergence:{lane}` and in /status's `divergence` array. Cron unchanged
(0 * * * *).

**Live proof (the alarm fires, then clears):**

| run | divergence rows | fleetHealth.state |
|---|---|---|
| 17:00:32Z (pre-anchor) | qmr1 → MISSING-ANCHOR (currentTip re-derived 3cc4afaf…); erised-ft1 → MISSING-ANCHOR (b92d3cd2…) | **DIVERGENCE-DETECTED** |
| 17:02:31Z (post-anchor) | qmr1 → MATCH; erised-ft1 → MATCH; z-67a-selftest → INDETERMINATE (selftest lane has no chain source — honest) | **healthy** |

5/5 organs bootable in both runs (corruption class stayed at zero; the delta is
purely additive). NOTE: KV list is eventually consistent (receipted wave-63) — the
first post-anchor check at 17:00:32Z still listed zero anchors; by 17:02:31Z the
lists had converged. The watcher's verdicts are only as fresh as KV list
consistency; direct GETs are stable immediately.

Local proofs: `node --test tests/tip-notary.test.mjs tests/divergence.test.mjs` —
30/30 (named validation, real-calendar days, content-addressed integrity,
per-lane chaining, worker round-trip on a KV mock, and the divergence simulation:
tail truncation → REGRESSED, fork → ADVANCED, missing anchor → MISSING-ANCHOR,
tampered anchor → corruption class). Existing harness still green: validate-dialect
38/38, VERDICT PASS.

## Dogfood — the two real anchors (fresh tips, fetched + re-derived this wave)

| lane | day | tip | source (GitHub raw) | re-derivation |
|---|---|---|---|---|
| `qmr1` | 2026-10-02 | `3cc4afaf4b8499fd2e64eadbe728f97320617c780e53e7141d69afa955fafd35` | SuperInstance/erised-fleet-table `ledger/fleet-snapshot/receipt-chain.jsonl` (the live qmr1 store.jsonl snapshot vendored by 66-d; quilt-mcp-receipts itself commits no store.jsonl — it is a runtime file) | 5 receipts re-derived from genesis per DESIGN.md §2 (id = sha256("qmr1:"+seq+":"+prev+":"+canon(body)), genesis prev 0×64); linkage 5/5 |
| `erised-ft1` | 2026-10-02 | `b92d3cd2e735e8f5fdad0c008446a93667aa4ee0c0a06c4bcb2a3e2bccf5f572` | SuperInstance/erised-fleet-table `ledger/session.json` | 73 rows re-derived per erised-sequencer engine.mjs law; cross-checked against the file's own verify.tip; matches 66-d's receipted tip |

Both GET back 200 with integrity "ok" (`GET /latest/qmr1`, `GET /latest/erised-ft1`).
Anchored at 2026-10-02T17:00:15.643Z / 17:00:17.746Z. These are the fleet's first
tips anchored outside their own repos: any future tail truncation of either chain
now shows up as REGRESSED against this history within an hour of the watcher's next
sweep.

## Who should anchor next (adoption list)

1. quilt-nn / quilt-attention: anchor `weight_root_sha` per epoch day.
2. cot-quilt: anchor the run receipt tip per phase.
3. erised-sequencer sessions: anchor per "chapter" (erised-ft1 is the pattern).
4. organ-boot-loader: anchor the store's manifestHash set daily (the store watches itself).
5. Fleet lanes: cite `GET /latest/{lane}` in worklogs as the external witness.
