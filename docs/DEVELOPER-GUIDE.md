# quilt-organ-workers — Developer Guide
> For developers extending the workers: adding endpoints, dialects, judges,
> lanes, or a fifth worker.

## Code layout

```
src/
  organ-boot-loader/worker.js   # the store: dialect detect + canonical/legacy validation + KV content-address + routes (678 lines)
  judge-relay/worker.js         # single-file worker: POST /judge fan-out to DeepInfra (231 lines)
  organ-watcher/worker.js       # cron entry + re-derivation sweep + /status dashboard (458 lines)
  organ-watcher/divergence.mjs  # divergenceSweep: anchored tips vs current tips (401 lines)
  organ-watcher/crosscheck.mjs  # crossCheckSweep + loadNotaryRows + fleetAgreement: two-notary law (397 lines)
  tip-notary/worker.js          # routes: POST /anchor, GET history/latest/status (274 lines)
  tip-notary/logic.mjs          # PURE law module: validation regexes, anchorSha256, selectPrevTip (runtime-agnostic, no imports)
  tip-anchor/worker.js          # sibling wave-66 worker (chain_id/seq witness, HMAC sigs) — deployed separately, kept in-tree for the record
schema/organ-manifest.v1.json   # THE registered dialect (L15 unification): canonicalization, identity laws, receipt law
fixture/
  organ-manifest-v1.json        # conforming canonical fixture (2 cells, 3 receipts)
  greeter-organ.json            # legacy transition fixture, preserved untouched
  make-organ-manifest-fixture.mjs / make-greeter-organ.mjs   # deterministic generators
scripts/
  deploy.sh                     # REST-only deploy of all workers (verify token → KV → multipart PUT script → cron → subdomain)
  deploy-organ-watcher.sh       # surgical 2-module deploy (worker.js + divergence.mjs + crosscheck.mjs) + cron re-assert
  deploy-tip-notary.sh          # surgical 2-module deploy (worker.js + logic.mjs)
  deploy-tip-anchor.sh          # surgical deploy of the sibling worker
  live-test.sh                  # round-trips (legacy + canonical) + watcher + judge fan-out; scrubbed transcript
  validate-dialect.mjs          # L15 harness: shared fixture vs BOTH implementations + negative controls (38 checks)
tests/
  tip-notary.test.mjs           # notary law on a KV mock (part of the 30/30 suite)
  divergence.test.mjs           # tail truncation → REGRESSED, fork → ADVANCED, missing anchor, tampered anchor
  crosscheck.test.mjs           # both-match / disagree / partial / tampered sig+sha fail-closed / pinned HMAC vector
  chrono-dialect.test.mjs       # chrono lane dialect join (wave-73 adoption)
receipts/                       # nine receipt files — live transcripts, findings, adoptions (see KNOWLEDGE-MAP.md)
docs/convergence-receipt.md     # twin-notary convergence + reconciliation
```

## Core concepts (named as the code names them)

- **Dialect** — which law a bundle speaks. `detectDialect(bundle)` returns
  `CANONICAL_SCHEMA = "quilt.organ.manifest/v1"` (from `bundle.schema`) or
  `LEGACY_SCHEMA = "quilt.organ.v1"` (from `bundle.schemaVersion`) or null.
  Canonical validation is `validateCanonicalBundle()` (exported, shared with the
  harness); legacy is `validateManifestShape` + `checkReceiptChain`.
- **canonical()** — the fleet's canonical JSON: recursive key-sorted, no
  whitespace, fail-closed on `undefined`/non-finite/bigint/function/symbol.
  Identical implementations live in the toolkit, the loader, the watcher, the
  notary's `logic.mjs`, and the fixture generator; `scripts/validate-dialect.mjs`
  proves byte-equality. Every hash in the system is `sha256hex(canonical(...))`.
- **Content address** — organ id = `sha256hex(canonical(manifest))` over the
  FULL manifest including `manifestHash`. Server-derived on PUT (never
  client-chosen); identical manifest ⇒ identical id ⇒ PUT idempotent; GET
  answers immutable (`ETag`, `Cache-Control: immutable`).
- **Boot-readiness (/verify)** — recompute every commitment server-side:
  `manifestDigestMatchesId`, `stateHashMatchesState`, `receiptChain`,
  `manifestHashSelfCover`, `cellsSha256MatchesState`, `perCellStateHashes`.
  `/verify` is re-derivation, not a stored flag.
- **rederiveBoot / runCycle (watcher)** — the monitor shares NO code path with
  the loader: it re-implements the same laws from the stored bytes and writes
  `watch:{organId}` rows plus `watch:_lastRun`. `driftDetected` is
  true/false/null (null = indeterminate, receipted as a finding, never guessed).
- **divergenceSweep verdicts** — `MATCH`, `REGRESSED` (current tip == an earlier
  anchored tip; the tail-truncation signature), `ADVANCED` (tip in no anchored
  history), `MISSING-ANCHOR`, `CORRUPT-ANCHOR` (anchor row fails sha256 —
  corruption class), `INDETERMINATE` (source down).
- **crossCheckSweep / notaryAgreement** — for each lane known to either notary,
  verify each witness under its own law (ours: sha256 re-derivation; Mavis's
  `quilt-tip-anchor`: HMAC under `WORKER_UPLOAD_TOKEN`); per-lane verdict
  `BOTH-MATCH` / `NOTARY-DISAGREE` / `PARTIAL` / `NO-ANCHORS`. Lanes join
  through `normalizeLaneId` (`:` → `-`, fail-closed on non-strings).
- **prevTipForLane (notary)** — each anchor stores the tip of the lane's most
  recent anchor on an earlier day (`selectPrevTip`), making the anchored
  history itself a chain — which is what makes REGRESSED detection possible.

## How to extend

### Add a new judge model alias (judge-relay)
One entry in `MODEL_ALIASES` (src/judge-relay/worker.js). Names containing `/`
pass through untouched, so only fleet short names need aliases:

```js
const MODEL_ALIASES = {
  "Hermes-3-405B": "NousResearch/Hermes-3-Llama-3.1-405B",
  "Qwen3.5-397B-A17B": "Qwen/Qwen3.5-397B-A17B",
  // "My-Short-Name": "vendor/model-id",
};
```
If the model is a reasoning model that burns budget on hidden reasoning, extend
the `qwenFamily` heuristic or rely on per-judge `no_thinking`. Redeploy
`ENV_KEYS=/home/z/my-project/.env.keys scripts/deploy.sh` (judge-relay is
single-file; the generic path handles it).

### Add a new divergence source (organ-watcher)
`divergence.mjs` derives a lane's CURRENT tip per source kind (GitHub raw chain
files re-derived from genesis; `organ_store` sources reuse the sweep's own
re-derived tips). To add a lane whose tip is derivable from a GitHub raw file,
extend `LANE_CONFIG` (code, not KV — adding a lane is one line + redeploy; a
KV-driven registry is an open backlog item). Implement the tip derivation per
that chain's law, return `{ok, tip, rows}`; the sweep compares against the
notary's anchored history and writes `watch:_divergence:{lane}`. Add a test to
`tests/divergence.test.mjs` modeled on the existing tail-truncation case.

### Add a new validation check to the canonical dialect
Edit `validateCanonicalBundle()` in `src/organ-boot-loader/worker.js` — it is
exported, and `scripts/validate-dialect.mjs` runs the EXACT production code
against the shared fixture, so a new check is automatically harnessed. Follow
the existing error shape: `bad(code, detail)` with a SCREAMING_SNAKE code
(`MANIFEST_INVALID`, `STATEHASH_MISMATCH`, ...). Mirror the check in the
watcher's `rederiveBoot()` ONLY if it should affect drift; then regenerate the
fixture with `node fixture/make-organ-manifest-fixture.mjs > fixture/organ-manifest-v1.json`
if your check changes hash-relevant fields, and re-run the harness.

### Add a fifth worker
Copy the pattern of `src/tip-notary/` (pure `logic.mjs` + thin `worker.js` so
`node --test` can test the law without a Workers runtime). Pick a KV key prefix
DISJOINT from the existing ones in the shared `quilt-organ-store` namespace:
`organ:`/`meta:` (loader), `watch:` (watcher), `anchor:`/`notary-latest:`
(notary). Never delete rows. Auth via `authOk()` (Bearer or `x-quilt-token`,
digest-compared). Add a surgical deploy script modeled on
`scripts/deploy-tip-notary.sh` (multipart module upload when >1 file).

## Testing
```bash
node --test tests/tip-notary.test.mjs tests/divergence.test.mjs   # 30/30 — notary law + divergence simulation
node --test tests/crosscheck.test.mjs                             # 17/17 — two-notary law incl. pinned HMAC vector
node --test tests/chrono-dialect.test.mjs                         # 10/10 — chrono lane join
node scripts/validate-dialect.mjs                                 # 38/38 — fixture vs BOTH implementations + negative controls
ENV_KEYS=/home/z/my-project/.env.keys scripts/live-test.sh        # live round-trips (needs the shared token in .env.keys)
```
Green means: every named fail-closed error fires at the right place, tamper
controls are rejected, the canonical fixture validates under BOTH
implementations (worker + toolkit), and the cross-canonicalizer battery is
byte-equal. All four suites verified green on Node v24.21.0. The harness needs
the toolkit peer checkout at `../quilt-jev-toolkit` (override with
`TOOLKIT_MANIFEST_MJS`; fail-closed if missing). Regenerate fixtures only via
the committed generators — they are deterministic by construction (fixed
createdAt), and their hashes are cross-verified in the receipts.

## Conventions
- **Fail-closed, named errors** — every rejection has a SCREAMING_SNAKE code
  (`E_DAY_CONFLICT`, `E_INTEGRITY`, `E_UNKNOWN_FIELD`, ...). Never fail open,
  never guess: `INDETERMINATE` is a verdict, not an excuse.
- **Never-delete-data** — KV rows are append/supersede only. The watcher writes
  only `watch:*`; the loader overwrites only its own `meta:` on idempotent PUT;
  the notary refuses day conflicts. Tampered rows stay (receipted) and read
  fail-closed (`E_INTEGRITY`).
- **No secrets in the repo** — token/key VALUES exist only in the gitignored
  `/home/z/my-project/.env.keys` and as Worker secrets (`secret_text` bindings
  or `wrangler secret put`). Docs and code carry env var NAMES only. Deploy
  scripts build metadata in chmod-600 temp files; transcripts are scrubbed.
- **Receipt discipline** — every deploy/live-test lands a file in `receipts/`
  with timestamps, exact commands, negative controls, and findings (including
  failures: F1, the score-first defect, the token rotation).
- **Pure-law modules** — validation/hash logic lives in `logic.mjs`-style
  modules importable by both the Workers runtime and `node --test`.
- **Commit style** — short imperative subjects, wave/task referenced in receipts
  rather than commit messages; pushes are verified `remote==local` (ls-remote)
  per the fleet discipline.

## Gotchas for editors
- **Do not single-file-deploy the watcher or the notary.** They import relative
  modules (`./divergence.mjs`, `./crosscheck.mjs`, `./logic.mjs`); a single-file
  upload boots into an unresolved-import crash. The deploy scripts upload
  multipart module bundles.
- **Do not add worker→worker HTTP calls.** Same-account fetches on
  `*.workers.dev` are platform-blocked (error-1042 class; receipted F1). Share a
  KV binding (how the notary/watcher/loader cooperate) or re-derive.
- **Keep canonical() byte-identical everywhere.** If you touch one
  implementation, run `scripts/validate-dialect.mjs`; a divergence in
  canonicalization silently changes every content address. Mind the JSON.stringify
  semantics (raw non-ASCII) — the Python caveat in USER-GUIDE applies to any new tooling.
- **`authOk` compares sha256 digests, not strings** — keep it that way
  (length-independent compare); never log or reflect the presented token.
- **The watcher must only write `watch:*`** — organ and anchor rows are evidence.
  `statusPayload` deliberately skips `watch:_*` in the organs listing; keep that
  separation if you add underscore-prefixed rows.
- **Lane-id normalization must never hide a fork**: different tips under
  different spellings still verdict `NOTARY-DISAGREE`; raw spellings stay
  receipted (`rawId`/`rawIds`). Preserve this when touching `crosscheck.mjs`.
- **Legacy dialect is transitional** — keep it accepted, keep the
  `x-quilt-schema-deprecated` header, do not extend it. New capability goes into
  the canonical dialect only.
- **`GET /organs` LIST_LIMIT is 64** and the watcher caps at `MAX_ORGANS = 512`
  per cycle for free-tier discipline; if the store grows past that, you are
  signed up for the indexer/replica backlog items, not silent truncation.
