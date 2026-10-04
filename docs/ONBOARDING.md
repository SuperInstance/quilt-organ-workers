# quilt-organ-workers — Agent Onboarding
> Zero-shot entry point. Clone → competent in ~10 minutes.

## Identity (2 sentences)
This repo is the SuperInstance fleet's serverless **organ infrastructure**: four Cloudflare Workers (plus a fifth sibling kept in-tree) that store bootable saved-state bundles ("organs"), fan candidates out to judge models, monitor every stored organ for drift, and anchor receipt-chain tips so tail truncation becomes detectable. Everything runs on the Cloudflare free tier, is CORS-open for reads, and is live right now — the workers serve real fleet traffic.

## Why it exists (the fleet problem it solves)
The fleet's core claim is the **quilt-organ**: a saved-state bundle (manifest + state + receipts) that a *different* agent can boot. That claim needed three instruments that a single repo cannot provide by itself. First, a neutral, always-on place to PUT and GET bundles so "bootable by others" does not depend on any lane's laptop (organ-boot-loader, wave 63, task 63-e). Second, a judge relay so the principal's "compose with some models, test with others" loop works from a lane with no local model access (judge-relay, wave 63). Third, an independent monitor plus an external tip notary, because wave-66's census found three repos stating the same honest limit — bare hash chains cannot detect tail truncation without an anchored tip (organ-watcher + quilt-tip-notary, waves 64/67, plus the two-notary cross-check of wave 68 and the lane-id normalization of wave 69-f). Every piece is receipted in `receipts/`; the L15 dialect unification (`receipts/DIALECT-UNIFICATION.md`) exists because two lanes independently produced two organ dialects and the fleet unified them at one registered schema string.

## Verify it works (exact commands)
Reads against the live workers need no credentials (CORS/GET is open):

```bash
# Liveness (all four workers answer 200)
curl -s https://organ-boot-loader.casey-digennaro.workers.dev/
curl -s https://judge-relay.casey-digennaro.workers.dev/health
curl -s https://organ-watcher.casey-digennaro.workers.dev/status | python3 -m json.tool | head -40
curl -s https://quilt-tip-notary.casey-digennaro.workers.dev/health

# Store census + boot-readiness of one stored organ (no auth)
curl -s https://organ-boot-loader.casey-digennaro.workers.dev/organs
curl -s https://organ-boot-loader.casey-digennaro.workers.dev/organ/677a3c79cde07ea4628c5326a446ee0719702cb0d476c38a44587dbea3552fcb/verify

# Local proof suites (Node >= 18; verified green on Node v24.21.0)
node --test tests/tip-notary.test.mjs tests/divergence.test.mjs   # 30/30
node --test tests/crosscheck.test.mjs                             # 17/17
node --test tests/chrono-dialect.test.mjs                         # 10/10
node scripts/validate-dialect.mjs                                 # 38/38 — needs the sibling checkout ../quilt-jev-toolkit (override TOOLKIT_MANIFEST_MJS); fail-closed if missing
```

Writes (PUT /organ, POST /judge, POST /check, POST /anchor) require the shared
`WORKER_UPLOAD_TOKEN` **as a Worker secret** — no Cloudflare account credentials
exist in a fresh clone, and none are committed anywhere in this repo. The proof
that authenticated paths work is receipted, not reproducible from a clone:
see `receipts/DEPLOYMENT.md` (live round-trips + negative controls, wave 63),
`receipts/TIP-NOTARY.md` (live anchors + tamper check, wave 67), and
`receipts/DUAL-ANCHOR-69F.md` (wave 69-f dual-anchors).

## Reading order (paths, not vibes)
1. `README.md` — the full endpoint tables, the canonical dialect `quilt.organ.manifest/v1`, deploy/test commands.
2. `schema/organ-manifest.v1.json` — THE registered dialect law (identity laws, receipt law, canonicalization). Read before uploading anything.
3. `src/organ-boot-loader/worker.js` — dialect detection, canonical validation, content-addressed store, /verify.
4. `src/organ-watcher/worker.js` + `divergence.mjs` + `crosscheck.mjs` — the monitor's independent re-derivation, the divergence verdicts, the two-notary cross-check.
5. `src/tip-notary/logic.mjs` + `worker.js` — the notary's law in one pure module (validation, integrity, per-lane chaining).
6. `receipts/DEPLOYMENT.md`, `receipts/ORGAN-WATCHER.md`, `receipts/TIP-NOTARY.md` — live transcripts including failure findings (F1: worker→worker fetch is platform-blocked).
7. `fixture/organ-manifest-v1.json` + `fixture/make-organ-manifest-fixture.mjs` — a conforming bundle you can copy.

## The things that will bite you (gotchas)
- **KV list is eventually consistent.** A fresh PUT may not appear in `GET /organs` for up to ~60 s (receipted at ~90 s in `receipts/DEPLOYMENT.md`). Use the id returned by PUT immediately; never gate on the list.
- **Same-account worker→worker fetches on `*.workers.dev` are platform-blocked** (instant unparseable 404, error-1042 class — `receipts/ORGAN-WATCHER.md` finding F1). Share KV bindings or re-derive; do not call a sibling worker over HTTP.
- **The watcher and the notary are TWO-MODULE bundles** (`worker.js` + `divergence.mjs`/`crosscheck.mjs` and `worker.js` + `logic.mjs`). A single-file REST upload deploys but dies at boot on the unresolved relative import. Use the deploy scripts.
- **Canonical JSON is JSON.stringify semantics** (raw non-ASCII, minimal escapes). Python's `json.dumps` default escapes `—` and produces a DIFFERENT content address — use `ensure_ascii=False, sort_keys=True, separators=(',',':')` (receipted in `receipts/TIP-ANCHOR.md`… the finding is recorded in `receipts/TIP-NOTARY.md`).
- **The notary never overwrites a scar**: same `{lane,day,tip}` re-POST is idempotent (200); same day with a different tip is `409 E_DAY_CONFLICT`. Rows are never deleted, by law.
- **Lane ids**: fleet canon carries colons (`erised-sequencer:anchor-proof`) but the notary's `LANE_RE` forbids them; the watcher's crosscheck joins lanes through `normalizeLaneId` (`:` → `-`, wave 69-f) while raw spellings stay receipted. Do not "fix" either side alone.
- **`GET /organs` lists at most 64 metas** (LIST_LIMIT) — fine at fleet scale, but not a full index.
- **`POST /check` and `POST /anchor` share one token** (`WORKER_UPLOAD_TOKEN`) with the loader's PUT and judge-relay's POST — one secret to rotate, four services affected.
- The tip-anchor sibling's pre-rotation HMAC rows verify as `sig-unverifiable` and stay on the books (`receipts/DUAL-ANCHOR-69F.md`); never treat them as valid witnesses.

## Where deeper knowledge lives
- Knowledge map: [docs/KNOWLEDGE-MAP.md](./KNOWLEDGE-MAP.md)
- Fleet journal: SuperInstance/superinstance-lab → worklog.md (grep `quilt-organ-workers`; tasks 63-e, 64-c, 66, 67-p, 68-a are load-bearing)
- `receipts/` — nine receipt files covering deploys, live tests, tamper checks, the convergence of the two notaries, and later adoptions (chrono lane, RD-005 tranche)
- `docs/convergence-receipt.md` — the twin-notary convergence event and the reconciliation verdict
- Related repos: `quilt-jev-toolkit` (the manifest law this dialect registers; peer checkout needed by the harness), `quilt-mcp-receipts` (sibling receipt organ; its v2 plan names this repo as the HTTP host), `erised-fleet-table` (vendors the live qmr1 snapshot whose tips are anchored here)

## Current frontier (what is open right now)
- **organ-boot-bridge** (Durable Object nesting coordinator: boot ticket + signed lease so two lanes can nest around the same saved state) — backlog item 2, unstarted.
- **judge-gauntlet** (rubric-hash-addressed verdict cache in KV so repeated gauntlets cost zero tokens) — backlog item 3, unstarted.
- **organ-mirror** (second-namespace read replica with failover) — backlog item 5, unstarted.
- Watcher follow-ups: drift-history rows (`watch:{id}:{checkedAt}`) and an alert hook when `fleetHealth.state` flips — named in the README backlog, not built.
- Notary adoption: anchor adoption by every chain-holding repo (quilt-nn epochs, cot-quilt run ledgers, erised checkpoints) and a KV-driven lane registry (today `LANE_CONFIG` is code — one line + redeploy to add a lane).
- `erised-sequencer:anchor-proof` stays NO-ANCHORS by design: its tip is not derivable from any committed artifact (`receipts/DUAL-ANCHOR-69F.md` §3). It becomes anchorable the moment the underlying session ledger is committed somewhere derivable.
