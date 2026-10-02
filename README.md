# quilt-organ-workers

Cloudflare Workers serving the SuperInstance fleet's **quilt-organ** concept:
*saved-state bundles bootable by others*. Four serverless pieces, free-tier only,
CORS-open so any lane agent anywhere can boot organs, call judges, anchor chain
tips, or read fleet organ health — no local model access, no wrangler login,
keys only as Worker secrets.

- **organ-boot-loader** — content-addressed store for organ bundles
  (manifest + state + receipts). Upload is schema-validated server-side;
  boot-readiness (`/verify`) is re-derived server-side. Principal's
  "saved state bootable by others", made serverless.
- **judge-relay** — fans a candidate out to judge models on DeepInfra
  (OpenAI-compatible) and returns per-judge verdicts + an aggregated score.
  Principal's "compose with some models, test with others", made serverless.
- **organ-watcher** — hourly cron monitor: independently re-derives every
  stored organ's commitments (manifest digest, stateHash, receipt chain under
  the organ's own dialect law, canonical extras) and publishes a fleet health
  dashboard at `GET /status`. The fleet's boot-readiness monitor. Wave 67
  added the **divergence delta**: anchored lane tips (quilt-tip-notary) are
  compared against each lane's current tip every cycle, so DIVERGENCE (two
  honest states disagree) is named separately from CORRUPTION (re-derivation
  fails).
- **quilt-tip-notary** — the fleet's external tip-anchor notary (wave 67):
  per-lane, per-day anchored 32-byte tips with per-lane chaining
  (`prevTipForLane`), content-addressed records (sha256 re-derived on every
  read), fail-closed named errors. Bare hash chains cannot detect tail
  truncation without an anchored tip — quilt-nn, quilt-qcells and
  slackwater-quilt all state the limit; qmr1 DESIGN.md §5 names this exact
  cure. "An anchor is a scar you choose in advance" (erised-fleet-table).

| worker | URL |
|---|---|
| organ-boot-loader | https://organ-boot-loader.casey-digennaro.workers.dev |
| judge-relay | https://judge-relay.casey-digennaro.workers.dev |
| organ-watcher | https://organ-watcher.casey-digennaro.workers.dev |
| quilt-tip-notary | https://quilt-tip-notary.casey-digennaro.workers.dev |

Deployment receipts: `receipts/DEPLOYMENT.md` (wave 63),
`receipts/DIALECT-UNIFICATION.md` (wave 64, L15), `receipts/ORGAN-WATCHER.md`
(wave 64), `receipts/TIP-ANCHOR.md` (wave 66 — the sibling chain-id/seq
witness `quilt-tip-anchor`), `receipts/TIP-NOTARY.md` (wave 67 — this notary
+ the watcher's divergence delta).

## THE canonical dialect: quilt.organ.manifest/v1 (L15 unification)

There was exactly one registered schema string since wave 64 — **read
`schema/organ-manifest.v1.json` before uploading** — plus a shared fixture both
implementations validate against (`scripts/validate-dialect.mjs`, 38/38).
Zero-shot uploaders: emit THIS shape.

```jsonc
{
  "schema": "quilt.organ.manifest/v1",                // THE registered string (bundle.schema)
  "manifest": {
    "schema": "quilt.organ.manifest",                  // toolkit manifest law, verbatim
    "schemaVersion": 1,
    "organId": "greeter-organ@d889ea55b2e46717",      // name@16hex; 16hex = sha256(canon({name, material: stateHash})).slice(0,16)
    "name": "greeter-organ",
    "cells": [ { "id": "greet-0", "kind": "greeter", "stateHash": "<hex64 per-cell>" } ],  // non-empty, unique ids
    "edges": [],
    "receiptRange": { "start": 0, "end": 2, "count": 3 },
    "genesis": { "seq": 0, "prevHash": "GENESIS" },
    "state": { "cellsSha256": "<hex64 of state.cells>" },
    "stateHash": "<hex64 of the WHOLE state>",        // registered extension (worker heritage)
    "supersedes": null,
    "manifestHash": "<hex64 self-cover: sha256(canon(manifest minus manifestHash))>"
  },
  "state": { "cells": { "...": {} } },
  "receipts": [                                        // optional but verified when present; full window required
    { "seq": 0, "op": { "type": "EFFECT", "cell": "greet-0", "text": "hello quilt" },
      "prev": "GENESIS", "hash": "<hex64 = sha256(canon({seq, op, prev}))>" }
  ]
}
```

- **canonical JSON** = recursive key-sorted, no whitespace, FAIL-CLOSED on
  undefined / NaN / Infinity / bigint / function / symbol (identical bytes in
  `quilt-jev-toolkit canonicalJson`, the worker `canonical()`, and
  `fixture/make-organ-manifest-fixture.mjs` — proven byte-equal by the harness).
- **organ id** (store content address) = `sha256hex(canonicalJSON(manifest))`
  over the FULL manifest including its internal `manifestHash` — derived by the
  SERVER, never client-chosen; identical manifest ⇒ identical id (PUT
  idempotent), GET answers immutable.
- **receipt chain** = the toolkit's law: `receipts[i].hash ==
  sha256hex(canonicalJSON({seq, op, prev}))`, `receipts[0].prev ==
  manifest.genesis.prevHash`, `receipts[i].prev == receipts[i-1].hash`,
  `receipts[i].seq == receiptRange.start + i`, and a present chain must be the
  FULL window (`receipts.length == receiptRange.count`). All effect content
  lives INSIDE `op` so the single hash covers it.
- A conforming fixture (2 cells, 3 receipts, real GENESIS→tip chain) is at
  `fixture/organ-manifest-v1.json` (generated by
  `fixture/make-organ-manifest-fixture.mjs`); the harness
  (`scripts/validate-dialect.mjs`) proves BOTH implementations validate it and
  reject every tampered control.

### Legacy transition dialect: quilt.organ.v1 (accepted, deprecated)

The wave-63 worker dialect (`bundle.schemaVersion: "quilt.organ.v1"`; digest
receipts `{seq, op, cell, prev, payload, digest}`, 1-based, `genesis`-anchored)
is still accepted. Every response to a legacy-dialect PUT carries the header
`x-quilt-schema-deprecated: quilt.organ.v1`; `/verify` reports the dialect of
whatever is stored. Before/after mapping + policy:
`receipts/DIALECT-UNIFICATION.md`. The legacy fixture is preserved untouched
at `fixture/greeter-organ.json`.

## organ-boot-loader endpoints

| route | auth | behavior |
|---|---|---|
| `GET /` | — | service index (dialect registry included) |
| `GET /organs` | — | list organs: id, schemaVersion (dialect), cellCount, receiptCount, stateHash, byteSize, uploadedAt |
| `PUT /organ` | token | detect dialect → validate (canonical: full toolkit law + whole-state; legacy: original law) → store; returns derived id + dialect + paths; legacy responses carry `x-quilt-schema-deprecated` |
| `GET /organ/{sha256}` | — | serve bundle; `ETag` + `x-quilt-organ-sha256` + `x-quilt-schema` headers; `Cache-Control: immutable` |
| `GET /organ/{sha256}/verify` | — | recompute every commitment server-side → `{bootable, reason, dialect, checks}` — a remote agent checks BEFORE booting; reports which dialect was served |

## organ-watcher endpoints

| route | auth | behavior |
|---|---|---|
| `GET /` | — | service index |
| `GET /status` | — | dashboard: last check per organ `{id, name, dialect, bootable, checkedAt, driftDetected, rederived, receiptTip}` + per-lane `divergence` rows + `fleetHealth` summary (`organsTracked/bootable/drifted/indeterminate/lanesTracked/divergences/anchorCorruption/state`) |
| `POST /check` | token | force one full check cycle NOW (same as the hourly cron) and return the fresh dashboard |

- Cron: hourly (`0 * * * *`), free-tier friendly. A cycle lists every organ id
  from the shared KV and INDEPENDENTLY re-derives the commitments from the
  stored bytes (it shares no code path with the loader — see
  `receipts/ORGAN-WATCHER.md` finding F1 for why it does not call `/verify`
  over HTTP: same-account worker→worker fetches on workers.dev are blocked by
  the platform).
- `driftDetected`: `true` = a stored organ FAILED re-derivation (**FINDING —
  receipted, never deleted**) · `false` = boot-ready · `null` = indeterminate.
- The watcher only ever WRITES `watch:*` rows; organ data and anchor rows are
  never touched.

### The divergence delta (wave 67, `src/organ-watcher/divergence.mjs`)

After every cycle, for each lane with anchored tips (quilt-tip-notary's
`anchor:*` keys in the SAME KV) ∪ each configured lane (`LANE_CONFIG`), the
watcher re-derives the lane's CURRENT tip (GitHub raw chain files re-derived
from genesis; `organ_store` sources use the sweep's own re-derived receipt
tips) and compares it against the notary's anchored history:

| verdict | class | meaning |
|---|---|---|
| `MATCH` | — | current tip == latest anchored tip |
| `REGRESSED` | divergence | current tip equals an EARLIER anchored tip — the chain went BACKWARDS (the tail-truncation signature three repos named) |
| `ADVANCED` | divergence | current tip is in no anchored history — store moved past the last anchor (stale anchor) or a fork exists ("a different file whose tip differs") |
| `MISSING-ANCHOR` | divergence | lane has a derivable current tip but never anchored |
| `CORRUPT-ANCHOR` | corruption | an anchored record failed its sha256 re-derivation (the anchor itself was tampered) |
| `INDETERMINATE` | — | source unreachable/unconfigured — recorded, never guessed |

Any divergence-class verdict flips `fleetHealth.state` to
**`DIVERGENCE-DETECTED`**; corruption (organs or anchor rows) stays
`DRIFT-DETECTED` — the two diseases are never conflated. Detail rows live at
`watch:_divergence:{lane}` and are served in `/status`'s `divergence` array.
Local proofs: `node --test tests/divergence.test.mjs` (tail truncation →
REGRESSED, fork → ADVANCED, missing anchor → MISSING-ANCHOR, tampered anchor →
corruption).

### The two-notary cross-check (wave 68, `src/organ-watcher/crosscheck.mjs`)

The fleet converged on TWO independent tip notaries within 9 hours of the
wave-66 census naming the organ (Mavis's `quilt-tip-anchor` at 08:08:17Z, our
`quilt-tip-notary` at 16:57:55Z) — see `docs/convergence-receipt.md`. After
every cycle, the watcher reads EVERY lane known to EITHER notary from BOTH KV
namespaces (`ORGANS` = shared organ store; `ANCHORS` = `quilt-tip-anchors`,
bound read-only) and verifies each witness under ITS OWN integrity law (ours:
sha256 content re-derivation; Mavis's: HMAC sig under the shared token). It
writes `watch:_notaries:{lane}` with per-lane `notaries` rows
`{notary, tip, state}` and a verdict:

| `notaryAgreement` | meaning |
|---|---|
| `BOTH-MATCH` | ≥ 2 valid witnesses anchored the same tip — dual-witnessed |
| `NOTARY-DISAGREE` | ≥ 2 valid witnesses anchored DIFFERENT tips for the same lane — **the alarm** (two chosen scars disagree); flips `fleetHealth.state` to `DIVERGENCE-DETECTED` |
| `PARTIAL` | exactly 1 valid witness (single coverage; not a fault, not yet proof) |
| `NO-ANCHORS` | 0 VALID witnesses (flawed rows — corrupt / `sig-unverifiable` — are receipted in the row detail, never counted) |

`fleetHealth.notaryAgreement` = max severity across lanes (disagree >
both-match > partial > no-anchors). Local proofs:
`node --test tests/crosscheck.test.mjs` (both-match, live-shaped disagree,
partial both directions, tampered sig/sha256 fail-closed, pinned HMAC vector,
sweep-level fleet verdict).

## quilt-tip-notary endpoints

| route | auth | behavior |
|---|---|---|
| `GET /` , `/health` | — | service index / liveness |
| `POST /anchor` | token | `{lane, day, tip, note?}` → 201 record `{lane, day, tip, anchoredAt, prevTipForLane, note?, sha256}`; same `{lane,day,tip}` again → 200 idempotent; same day with a DIFFERENT tip → 409 `E_DAY_CONFLICT` (a chosen scar is never overwritten) |
| `GET /anchor/{lane}/{day}` | — | the record, sha256 re-derived; tampered row → 500 `E_INTEGRITY` |
| `GET /anchor/{lane}` | — | lane history: days + latest record |
| `GET /latest/{lane}` | — | most recent anchor record for the lane |
| `GET /status` | — | `{lanesTracked, lanes:[{lane, day, tip, anchoredAt, prevTipForLane, integrity}], healthy}` |

- **Validation is fail-closed with named errors**: `E_BODY_FORMAT`,
  `E_LANE_FORMAT` (`^[a-z0-9][a-z0-9_-]{0,63}$`), `E_DAY_FORMAT` (a REAL UTC
  calendar date — 2026-02-30 is rejected), `E_TIP_FORMAT` (32 bytes as 64
  lowercase hex), `E_NOTE_FORMAT` (≤512 chars), `E_UNKNOWN_FIELD` (strictness
  on purpose, the qmr1 law).
- **Content-addressed integrity**: the record's `sha256` field is
  `sha256(canonicalJSON({anchoredAt, day, lane, note, prevTipForLane, tip}))`
  (recursive key-sorted, no whitespace — the fleet's canonical law) and is
  re-derived on EVERY read; a row that fails re-derivation answers 500
  `E_INTEGRITY`, never the bytes alone.
- **Per-lane chaining**: each anchor stores `prevTipForLane` = the tip of the
  lane's most recent anchor on an earlier day — the anchored history is itself
  a chain, which is what makes REGRESSED detection possible.
- **KV layout** (the SHARED `quilt-organ-store` namespace, binding `ORGANS` —
  the organ store the wave-66 census found "unused for exactly this"):
  `anchor:{lane}:{day}` → record · `notary-latest:{lane}` → latest-day pointer.
  Prefixes are disjoint from the loader's `meta:`/`organ:*` and the watcher's
  `watch:*`. Rows are never deleted.
- **Sibling, not rival**: `quilt-tip-anchor` (wave 66) is the chain-id/seq
  timestamp witness with HMAC-signed rows in its own namespace; `tip-notary`
  is the lane/day-chained anchor the watcher's divergence delta reads. Post to
  both for belt-and-suspenders custody.
- Dogfooded anchors: see `receipts/TIP-NOTARY.md` (lanes `qmr1` and
  `erised-ft1`, real chain tips fetched and re-derived from GitHub raw).

Notes:
- CORS is open (`*`) on every route, OPTIONS preflight answered 204 — any agent
  anywhere can boot organs. That is the point.
- KV-backed (`quilt-organ-store` namespace). **`GET /organs` is eventually
  consistent**: KV list can lag a fresh PUT by up to ~60 s (receipted in
  `receipts/DEPLOYMENT.md`). Direct gets are stable immediately after upload.
- Size guard: 8 MiB per bundle.

## judge-relay endpoints

| route | auth | behavior |
|---|---|---|
| `GET /health` | — | service index (no secrets echoed) |
| `POST /judge` | token | `{candidate, rubric, judges:[{provider?, model, max_tokens?, no_thinking?}], temperature?}` → per-judge verdicts + aggregate |

- Provider `deepinfra` → `https://api.deepinfra.com/v1/openai/chat/completions`.
- Fleet short names resolved server-side: `Hermes-3-405B` →
  `NousResearch/Hermes-3-Llama-3.1-405B`, `Qwen3.5-397B-A17B` →
  `Qwen/Qwen3.5-397B-A17B` (anything containing `/` passes through untouched).
- **Score-first contract**: the relay requires each judge to BEGIN its verdict
  with `SCORE: <n>/10`; the relay parses that line and returns
  `aggregate {mean, min, max, spread, n, n_total}`. Raw verdict text, usage
  tokens and latency are always included per judge.
- Free-tier discipline: `max_tokens` defaults to 64, hard-capped at 256;
  ≤ 8 judges per request; 60 s per-judge timeout; Qwen-family models get
  `enable_thinking:false` by default (per-judge `no_thinking` overrides) so the
  token budget is not silently consumed by hidden reasoning.

## Auth + secret discipline

One shared token (`WORKER_UPLOAD_TOKEN`) guards `PUT /organ`, `POST /judge`,
the watcher's `POST /check`, and the notary's `POST /anchor`:

```
Authorization: Bearer <WORKER_UPLOAD_TOKEN>     # or header: x-quilt-token: <token>
```

- The token value lives ONLY in the gitignored `/home/z/my-project/.env.keys`
  (appended as `WORKER_UPLOAD_TOKEN=...` this wave) and as Worker secrets.
- **Lane agents rotate/set it with wrangler** (no wrangler login needed when
  `CLOUDFLARE_API_TOKEN` is exported):

  ```bash
  export CLOUDFLARE_API_TOKEN=$(grep '^CLOUDFLARE_API_TOKEN=' /home/z/my-project/.env.keys | cut -d= -f2-)
  npx wrangler secret put WORKER_UPLOAD_TOKEN --name organ-boot-loader   # paste value on stdin
  npx wrangler secret put WORKER_UPLOAD_TOKEN --name judge-relay
  npx wrangler secret put WORKER_UPLOAD_TOKEN --name organ-watcher
  npx wrangler secret put DEEPINFRA_KEY        --name judge-relay        # alias: DEEPINFRA_API_KEY
  ```

  (The REST equivalent used by `scripts/deploy.sh`: `secret_text` bindings in
  the upload metadata — same effect, no wrangler install.)
- No secret appears in code, fixtures, or receipts; transcripts are scrubbed.

## Deploy / test

```bash
ENV_KEYS=/home/z/my-project/.env.keys scripts/deploy.sh     # verify token → KV → upload all four workers → cron → enable *.workers.dev
ENV_KEYS=/home/z/my-project/.env.keys scripts/deploy-tip-notary.sh      # surgical: quilt-tip-notary only
ENV_KEYS=/home/z/my-project/.env.keys scripts/deploy-organ-watcher.sh   # surgical: organ-watcher only (2-module) + cron re-assert
ENV_KEYS=/home/z/my-project/.env.keys scripts/live-test.sh  # round-trips (legacy + canonical) + watcher + judge fan-out (redacted transcript)
node scripts/validate-dialect.mjs                           # L15 harness: fixture vs BOTH implementations + negative controls (38 checks)
node --test tests/tip-notary.test.mjs tests/divergence.test.mjs   # wave-67: notary law (30 checks) + divergence simulation
node fixture/make-greeter-organ.mjs          > fixture/greeter-organ.json       # legacy transition fixture
node fixture/make-organ-manifest-fixture.mjs > fixture/organ-manifest-v1.json   # canonical fixture
```

The dialect harness needs the toolkit peer checkout at
`../quilt-jev-toolkit` (override with `TOOLKIT_MANIFEST_MJS`; fail-closed if
missing). Both deploy scripts read every credential from the gitignored
`.env.keys`; nothing is hardcoded. Account id (non-secret) pinned in
`scripts/deploy.sh`.

**Module-bundle deploys**: organ-watcher (worker.js + divergence.mjs) and
quilt-tip-notary (worker.js + logic.mjs) are TWO-MODULE bundles — they are
uploaded as multipart module parts (wrangler's bundle format over the REST
API); a single-file upload of the watcher would fail at boot on the unresolved
`./divergence.mjs` import.

## Inventive-uses backlog (ranked, deploy next)

1. ~~**organ-watcher (cron trigger worker)**~~ — DONE wave 64 (64-c):
   https://organ-watcher.casey-digennaro.workers.dev — hourly independent
   re-verification + `GET /status`; receipt `receipts/ORGAN-WATCHER.md`.
   Follow-ups: drift-history rows (`watch:{id}:{checkedAt}`) and an alert hook
   (pinned status organ / notification lane) when `fleetHealth.state` flips to
   `DRIFT-DETECTED`.
2. **organ-boot-bridge (Durable Object “nesting” coordinator)** — a DO that
   hands an incoming agent a boot ticket: organ id + receipt-cursor + a signed
   lease, so two lanes can nest around the SAME saved state without racing.
   The quilt “drop-in nesting” primitive.
3. **judge-gauntlet (weight-verified panel cache)** — judge-relay plus a
   rubric-hash-addressed verdict cache in KV (`rubric+candidate → verdicts`),
   so repeated gauntlets across lanes cost zero tokens on identical inputs.
4. ~~**receipt-anchor** — a worker that stores ONLY 32-byte receipt tips per
   lane per day (KV, tiny), giving every lane a free external notary it can
   cite in worklogs (`anchor:{lane}/{date}`)~~ — DONE wave 67 (67-a):
   https://quilt-tip-notary.casey-digennaro.workers.dev with per-lane chaining
   + content-addressed integrity + the watcher's divergence delta; receipt
   `receipts/TIP-NOTARY.md`. Follow-ups: anchor adoption by every chain-holding
   repo (quilt-nn epochs, cot-quilt run ledgers, erised checkpoints, the
   organ store's own manifestHash on upload), a KV-driven lane registry (today
   `LANE_CONFIG` is code — one line + redeploy to add a lane), and the
   `receipt-primitive` distillation (one {seq, prev, body, id, sig?} law with
   pluggable hash + shared tamper conformance harness).
5. **organ-mirror** — second-worker, second-namespace read replica of the
   organ store; boot-loaders fail over if the primary KV is degraded.

## Fleet notes

- Free-tier usage receipted in `receipts/DEPLOYMENT.md` (requests, KV ops,
  judge tokens — all trivially inside caps).
- This repo has NO secrets: the only key-shaped strings ever committed are
  hash digests of fixtures (64-hex, safe by construction).
