# quilt-organ-workers — Engineering Notes
> Architecture, invariants, failure modes, cost envelope, operations, and the
> real design decisions — for engineers operating or reviewing the system.

## Architecture

Four Cloudflare Workers (plus the in-tree wave-66 sibling `src/tip-anchor/`,
deployed into its own KV namespace) over two KV namespaces. All reads are
CORS-open; all writes share one secret (`WORKER_UPLOAD_TOKEN`).

```
                        any agent, anywhere (CORS *)
                                 │  GET (open)                 PUT/POST (Bearer/x-quilt-token)
                                 ▼                                     ▼
 ┌───────────────────────┐   ┌──────────────────────┐   ┌───────────────────────────┐
 │ organ-boot-loader     │   │ organ-watcher        │   │ judge-relay               │
 │ PUT /organ (auth)     │   │ cron 0 * * * *       │   │ POST /judge (auth)        │
 │ GET /organ/{id}       │   │ POST /check (auth)   │   │  → DeepInfra chat/completions
 │ GET /organ/{id}/verify│   │ GET /status (open)   │   │    (api.deepinfra.com)     │
 └──────────┬────────────┘   └─────────┬────────────┘   └───────────────────────────┘
            │ ORGANS binding           │ ORGANS (write only watch:*)  secrets: WORKER_UPLOAD_TOKEN,
            ▼                          │ ANCHORS (read-only)          DEEPINFRA_KEY | DEEPINFRA_API_KEY
 ┌───────────────────────────────────────────────────────┐
 │ KV namespace quilt-organ-store  (binding ORGANS)      │   ┌──────────────────────────────┐
 │   organ:{id}      bundle envelope (immutable bytes)   │   │ quilt-tip-notary             │
 │   meta:{id}       list metadata (LIST_LIMIT 64)       │   │ POST /anchor (auth)          │
 │   watch:{id}      watcher verdict rows                │   │ GET /anchor|/latest|/status  │
 │   watch:_lastRun, watch:_divergence:{lane},           │   └───────────────┬──────────────┘
 │   watch:_notaries:{lane}                              │                   │ ORGANS binding (shared KV)
 │   anchor:{lane}:{day}, notary-latest:{lane}           │                   ▼
 └───────────────────────────────────────────────────────┘   ┌──────────────────────────────┐
                                                             │ KV quilt-tip-anchors (56db…) │
   sibling: quilt-tip-anchor (src/tip-anchor/)               │ anchor:{chain}:{seq}         │
   POST /anchor {chain_id,tip,seq} → HMAC-signed rows        │ latest:{chain}, index:{chain}│
                                                             └──────────────────────────────┘
```

Data flow for the core loop: an uploader PUTs a bundle → the loader derives the
content address server-side, validates under the bundle's own dialect, and
stores `organ:{id}` + `meta:{id}` → a consumer GETs `/organ/{id}/verify`, which
re-derives every commitment from the stored bytes before booting → the watcher,
hourly, re-derives the same commitments INDEPENDENTLY (no shared code path),
writes `watch:*` rows, then runs the divergence delta (current lane tips vs the
notary's anchored history) and the two-notary cross-check (each witness verified
under its own integrity law), publishing everything at `GET /status`.

## Invariants
1. **Content-address immutability** — organ id = `sha256hex(canonicalJSON(manifest))`,
   server-derived; GET answers carry `ETag: "{id}"` and
   `Cache-Control: public, max-age=31536000, immutable`. Enforced in the loader's
   PUT path and re-checked by `/verify` (`manifestDigestMatchesId`).
2. **Fail-closed everything** — validation rejects with named codes; the notary
   answers `E_INTEGRITY` (500) rather than serving a row that fails sha256
   re-derivation; the watcher's `driftDetected: null` (indeterminate) is
   recorded, never guessed. Enforced in `validateCanonicalBundle`,
   `checkCanonicalReceiptChain`, `getIntegrityChecked`, `rederiveBoot`.
3. **The monitor shares no code path with the service it watches** — the
   watcher re-implements canonical() and both chain laws from the stored bytes.
   This is the drift-monitoring contract from `receipts/ORGAN-WATCHER.md`.
4. **Never-delete-data** — no code path deletes KV rows; tamper evidence
   persists and is receipted. Enforced by construction (only `put` calls exist)
   and by the notary's `E_DAY_CONFLICT` law.
5. **Corruption ≠ divergence** — re-derivation failure is the corruption class;
   two honest states disagreeing (REGRESSED/ADVANCED/MISSING-ANCHOR/
   NOTARY-DISAGREE) is the divergence class. `fleetHealth.state` maps them to
   `DRIFT-DETECTED` vs `DIVERGENCE-DETECTED` and never conflates them.
6. **One token, digest-compared** — every write path authenticates the same
   `WORKER_UPLOAD_TOKEN` via sha256-digest comparison (length-independent);
   token values never appear in code, fixtures, receipts, or logs.
7. **Dialect honesty** — `/verify` and every watch row report the dialect the
   organ was served as; legacy PUT responses carry
   `x-quilt-schema-deprecated: quilt.organ.v1`.

## Failure modes & blast radius
- **Loader down**: GETs of stored organs fail (they are served by the loader);
  the watcher keeps re-deriving (it reads KV directly, by design "it still works
  when the loader itself is down" — receipted design goal). Blast radius: no new
  uploads, no fresh /verify; already-published organ ids remain verifiable via
  the watcher dashboard.
- **KV eventual consistency**: a PUT may be invisible to lists for ~60 s
  (receipted ~90 s). Mitigation: PUT returns the id; consumers use direct gets.
  Blast radius: cosmetic dashboard lag, not data loss.
- **Watcher crash mid-cycle**: cron re-fires hourly; `watch:_lastRun` carries an
  `error` field on sweep exceptions; divergence/crosscheck exceptions are caught
  per-sweep and recorded as `error` without killing the organ sweep. Blast
  radius: one stale dashboard hour.
- **Judge model outage / DeepInfra errors**: per-judge `ok:false` with the
  upstream error sliced to 300 chars; aggregate still returns over the judges
  that answered (`n` vs `n_total` makes partial panels visible). 60 s per-judge
  timeout via `AbortSignal.timeout`. Blast radius: one request.
- **Anchor tampering (storage-level)**: the notary serves 500 `E_INTEGRITY` on a
  tampered row (live-proven: tamper → 500 → honest bytes restored → 200); the
  watcher classifies `CORRUPT-ANCHOR` (corruption class). A row with an
  unverifiable HMAC sig (pre-rotation) counts as flawed — receipted, never
  counted as a valid witness.
- **Chain tail truncation in a watched lane**: the divergence delta flips the
  lane to `REGRESSED` and `fleetHealth.state` to `DIVERGENCE-DETECTED` within
  one hour (live-proven in `receipts/TIP-NOTARY.md`: alarm fires 17:00:32Z,
  clears 17:02:31Z after anchoring).
- **Single-file deploy of a multi-module worker**: deploys fine, crashes at boot
  on the unresolved import (worker 1101 class). Mitigation: surgical deploy
  scripts; blast radius: that worker only, rolled back by re-running the script.

## Performance & cost envelope
All numbers are either measured in receipts or read from the current dashboard;
estimates are labeled.

- **Workers free tier** (receipted, `receipts/DEPLOYMENT.md`): ~35 requests in
  the wave-63 deploy window against a 100,000/day cap; CPU per request well
  under the 10 ms budget (sha256 + small KV ops).
- **KV free tier** (receipted): ~5 writes/day typical early usage (cap 1,000/day),
  ~25 reads (cap 100,000/day), ~2 KB stored (cap 1 GB). Steady state: the
  hourly cron costs ~2 KV writes/organ/cycle + 1 summary row (24 cycles/day);
  with `MAX_ORGANS = 512`, reads/cycle are bounded ≤ ~2x that.
- **Judge tokens** (receipted): 3 calls, 1,139 tokens, ≈ $0.0013 via DeepInfra's
  returned usage/cost fields. `max_tokens` default 64 / cap 256 and ≤ 8 judges
  per request bound every call.
- **Measured cycle durations** (receipted + dashboard): forced cycle
  `durationMs` 2241 for 3 organs (wave 64); live dashboard 2026-10-04 shows the
  hourly cron at 2876 ms for 5 organs with 5 notary lanes — trivially inside
  every limit.
- **Latency of judge calls** (receipted): ~3.7 s for one 405B-class verdict at
  max_tokens 64. Estimate, labeled: a full 8-judge panel runs concurrently
  (`Promise.all`), so wall time ≈ the slowest judge.

## Operations
- **Local**: the test suites are stdlib-only Node (`node --test ...`), verified
  green on v24.21.0; the dialect harness additionally needs the toolkit peer
  checkout (`../quilt-jev-toolkit`).
- **Deployment** (no wrangler login, no account credentials in any clone):
  `scripts/deploy.sh` and the surgical scripts drive the Cloudflare REST API:
  verify token → find-or-create KV across paginated lists → multipart PUT script
  with `secret_text` bindings → cron trigger → enable `*.workers.dev` subdomain.
  organ-watcher and quilt-tip-notary upload as 2-module (3-module for the
  watcher's crosscheck) multipart bundles.
- **Credentials model (honest)**: no Cloudflare account credentials exist in the
  container or the repo. Values live ONLY in the gitignored
  `/home/z/my-project/.env.keys` (`CLOUDFLARE_API_TOKEN`, `DEEPINFRA_KEY` /
  `DEEPINFRA_API_KEY`, `WORKER_UPLOAD_TOKEN`) and as Worker secrets on the
  account. Deploys were performed from the lane that owns those credentials
  (waves 63-67 receipted in `receipts/`). Rotation history: the shared token was
  regenerated in wave 67 (prior value unrecoverable — write-only secret) and
  re-attached to all four workers; an incident note in `receipts/DEPLOYMENT.md`
  discloses a `bash -x` echo of `CLOUDFLARE_API_TOKEN` into a local session
  (zero tracked-file hits; rotation flagged at the next wave boundary).
  Readers of this repo should assume they can deploy nothing until a lane with
  `CLOUDFLARE_API_TOKEN` exported runs the scripts.
- **CI**: none — the fleet's proof standard is receipts, not pipelines. The test
  suites run offline on demand.
- **Runtime monitors**: `GET /status` on organ-watcher (organ health + divergence
  + notary agreement), `GET /status` on the notary (lane integrity), `GET /health`
  liveness endpoints. The cron is `0 * * * *` UTC.

## Design decisions & why
1. **Content-addressed store instead of client-named keys** (wave 63) — the id
   is derived server-side, making PUT idempotent, GET immutable, and tampering
   with a manifest detectable as "no organ at that address". Tradeoff: renaming
   or editing an organ means a new id; supersession is expressed in the manifest
   (`supersedes` field), not by overwrites.
2. **Independent re-derivation instead of calling `/verify` over HTTP** (wave
   64, finding F1) — the first design called the loader's /verify and was
   platform-blocked (same-account worker→worker fetches on workers.dev are
   refused, error-1042 class, ~2 ms unparseable 404). The sanctioned fallback is
   strictly stronger: the monitor shares no code path with the service and works
   when the loader is down. Tradeoff: canonical()/chain-law duplication across
   two workers, contained by the L15 harness.
3. **Dialect unification at ONE registered schema string** (wave 64, L15) — two
   lanes had produced two organ dialects; lesson L15 said register the schema in
   one place and validate both implementations against a shared fixture. The
   canonical dialect is the toolkit's manifest law verbatim plus the registered
   whole-state `stateHash`; the legacy worker dialect stays accepted with a
   deprecation header. Tradeoff: dual validation paths in the loader during
   transition.
4. **Score-first judge contract** (wave 63) — verdicts at max_tokens 64 were
   truncated BEFORE a score-last line, yielding aggregate mean null (receipted
   as a defect). Requiring `SCORE: <n>/10` as the first line makes the score
   survive tiny budgets. Tradeoff: constrains judge formatting; raw verdict text
   is always returned alongside.
5. **Anchored tips as scars; two notaries kept** (waves 66-68) — bare hash
   chains cannot detect tail truncation (named by three repos + qmr1 DESIGN.md
   §5), so the notary anchors per lane per day with per-lane chaining, and when
   a second independent notary appeared 8h49m later the fleet kept BOTH and made
   the watcher verify each witness under its own law (`NOTARY-DISAGREE` = the
   alarm). Tradeoff: more moving parts; the alternative (one notary) would have
   made the anchor a single point of trust.
6. **Lane-id normalization without laundering** (wave 69-f) — fleet canon
   carries colons, the notary's lane law forbids them; the crosscheck joins on
   `normalizeLaneId` while raw spellings stay receipted, and different tips under
   different spellings still verdict `NOTARY-DISAGREE`. Tradeoff: none accepted
   that hides a fork — normalization never merges disagreeing witnesses.
