# receipts/DEPLOYMENT.md — organ-boot-loader + judge-relay (lane 63-e)

Wave 63, Task 63-e. Deployed via Cloudflare REST API only (no wrangler login).
All credentials from gitignored `/home/z/my-project/.env.keys`; nothing hardcoded
anywhere in this repo.

## Account / endpoints

- Account id: `049ff5e84ecf636b53b162cbb580aae6` (account name: Casey.digennaro@gmail.com's Account)
- Token status at deploy: `GET /client/v4/user/tokens/verify` → `active`
- workers.dev subdomain: `casey-digennaro`
- KV namespace: `quilt-organ-store` = `cd5a5b7efdaf436287a916230262d726` (created this wave; free tier)

| worker | URL | bindings |
|---|---|---|
| organ-boot-loader | https://organ-boot-loader.casey-digennaro.workers.dev | `ORGANS` (kv_namespace), `WORKER_UPLOAD_TOKEN` (secret_text) |
| judge-relay | https://judge-relay.casey-digennaro.workers.dev | `WORKER_UPLOAD_TOKEN` (secret_text), `DEEPINFRA_KEY` (secret_text), `DEEPINFRA_API_KEY` (secret_text alias) |

Deployment timestamps (UTC):

- `2026-10-01T23:13:57Z` — both workers first deployed + subdomain enabled.
- `2026-10-01T23:17:04Z` — judge-relay redeployed with score-first scoring
  contract (v1 with score-last truncated before the SCORE line at 64 tokens —
  receipted below, fixed, re-tested).
- Settings verified via `GET /workers/scripts/{name}/settings` after each
  upload: bindings present exactly as listed above.

## Live-test transcript (redacted; token never printed)

Fixture: `fixture/greeter-organ.json` — 2 cells, 3 receipts (real genesis→tip
hash chain), 1807 bytes. Generated deterministically; hashes cross-verified
independently (node crypto recompute of chain + stateHash + id: all OK).

- organ id: `164015d9bfdd126e8ae36871bb645d37ce6f8475f2b7f42594f3b259b9369636`
- stateHash: `4a04728f3c3de9b35fae6a8cc54abe72387d13dfe052af7f3be355456b63026e`

### organ-boot-loader round-trip

```
PUT /organ (fresh upload, auth)  → HTTP 201
{ "ok": true, "stored": true,
  "id": "164015d9bfdd126e8ae36871bb645d37ce6f8475f2b7f42594f3b259b9369636",
  "cellCount": 2, "receiptCount": 3,
  "stateHash": "4a04728f..." }

PUT /organ (same bundle again)   → HTTP 200 { "stored": false, "alreadyExisted": true }   # content-addressed idempotence

GET /organ/164015d9...           → HTTP 200
  headers: etag: "164015d9..."
           x-quilt-organ-sha256: 164015d9...
           cache-control: public, max-age=31536000, immutable
           access-control-allow-origin: *
  body: canonical-identical to fixture (cmp of key-sorted dumps: ✓ byte-identical)

GET /organ/164015d9.../verify    → HTTP 200
{ "ok": true, "bootable": true,
  "reason": "manifest digest == id; sha256(canonicalJSON(state)) == manifest.stateHash; every receipt digest re-derives and the chain links genesis→tip matching receiptRange",
  "checks": { "manifestDigestMatchesId": true, "stateHashMatchesState": true, "receiptChain": true, "receiptReason": null } }

GET /organs                      → HTTP 200
{ "ok": true, "count": 1, "organs": [ { "id": "164015d9...", "schemaVersion": "quilt.organ.v1",
  "cellCount": 2, "receiptCount": 3, "name": "greeter-organ", "stateHash": "4a04728f...",
  "byteSize": 1807, "uploadedAt": "2026-10-01T23:14:47.252Z" } ] }
```

Negative controls (all fail-closed):

```
PUT /organ without auth                          → HTTP 401 unauthorized
PUT tampered state (stale stateHash)             → HTTP 400 "stateHash mismatch: manifest says 4a04..., sha256(canonicalJSON(state)) is 7ec8c802..."
PUT forged receipt payload (digest unchanged)    → HTTP 400 "receipt chain invalid: receipts[1] digest mismatch: recomputed 2b4439dd..., stored 2b4b07fd..."
PUT schemaVersion "quilt.organ.v9"               → HTTP 400 "unsupported schemaVersion"
GET /organ/000...000/verify                      → HTTP 404 "no organ with id 000... in this store"
```

### judge-relay

```
GET /health (no auth)     → HTTP 200 { "service": "judge-relay", "ok": true, providers:["deepinfra"], ... }
POST /judge without auth  → HTTP 401 unauthorized
```

First run (score-LAST contract) — fan-out and usage OK but `finish_reason:"length"`
at max_tokens 64 truncated the verdicts BEFORE the SCORE line ⇒ aggregate mean
null. RECEIPTED AS DEFECT, fixed to score-first contract, redeployed 23:17:04Z.

Post-fix run 1 (1 judge, max_tokens 64):

```
POST /judge {candidate: quilt-organ manifest receipt-pinning proposal,
             rubric: soundness + economy,
             judges: [{provider:"deepinfra", model:"Hermes-3-405B", max_tokens:64}]}
→ HTTP 200
  model resolved: NousResearch/Hermes-3-Llama-3.1-405B (fleet short name)
  score: 8 (parsed from contract line "SCORE: 8/10")
  content: "SCORE: 8/10\n\nThe proposal of pinning receipt digests in the manifest ... trust in the bundle's integrity. However, the economy criterion is"
  usage: {prompt_tokens: 148, completion_tokens: 64, total_tokens: 212, estimated_cost: 0.000212}
  finish_reason: "length"   latency_ms: 3687
  aggregate: {n:1, n_total:1, mean:8, min:8, max:8, spread:0}
```

Post-fix run 2 (2 judges, max_tokens 64 — the compose/test-other-models loop):

```
judges: [{model:"Hermes-3-405B"}, {model:"Qwen3.5-397B-A17B"}]
→ HTTP 200
  Hermes-3-405B           → score 8, "SCORE: 8/10\n\nThe proposed change to use sha256(canonicalJSON(manifest)) ...", usage {133+64 tok}
  Qwen/Qwen3.5-397B-A17B  → score 9, "SCORE: 9/10\nThe proposal soundly decouples logical identity from physical packaging, ...", usage {143+64 tok}
  aggregate: {n:2, n_total:2, mean:8.5, min:8, max:9, spread:1}
```

(Qwen note: with thinking enabled the 64-token budget vanished into hidden
reasoning and returned empty content — first-run receipt above; relay now
sends `chat_template_kwargs:{enable_thinking:false}` for Qwen-family by
default; per-judge `no_thinking` overrides.)

## Free-tier usage (this wave, receipted)

- Workers requests: ~35 total (free cap 100,000/day). CPU per request well under the 10 ms free-tier budget (hash + small KV ops).
- KV: ~5 writes (organ + meta + idempotent meta rewrites; cap 1,000/day), ~25 reads incl. lists (cap 100,000/day), ~2 KB stored (cap 1 GB).
- DeepInfra judge calls: 3 requests, 1,139 total tokens, estimated cost ≈ $0.0013 (fields returned by DeepInfra; both models 405B/397B-class).
- Everything else: $0.

## Operational findings (for the next lanes)

- **KV list is eventually consistent**: fresh organ (uploadedAt 23:14:47.252Z)
  was NOT in `GET /organs` ~10 s after upload, appeared by ~90 s. Direct gets
  are stable immediately. Lane agents: after PUT, use the returned id directly
  (GET /organ/{id}, /verify) — don't gate on /organs within a minute.
- `GET /organs` currently lists the first 64 metas; fine for fleet scale; the
  indexer worker in the backlog would replace it if we ever outgrow KV.
- DeepInfra fleet short names resolve server-side (alias map in judge-relay);
  anything with a `/` passes through untouched.

## Security receipts

- Secrets touched this wave: `CLOUDFLARE_API_TOKEN` (pre-existing, .env.keys),
  `DEEPINFRA_API_KEY` (pre-existing, .env.keys), `WORKER_UPLOAD_TOKEN`
  (GENERATED this wave, appended to .env.keys, installed as secret_text on both
  workers; value ONLY in .env.keys — gitignored — never in this repo).
- **Incident note (honest disclosure):** during debugging, `bash -x` on
  `scripts/deploy.sh` echoed the CLOUDFLARE_API_TOKEN into the local session
  output. The repo was never involved; a targeted scan of tracked files and
  `tool-results/` for `cfut_` found ZERO hits; nothing was pushed. Flagged for
  token rotation at next wave boundary per fleet key-hygiene practice.
- deploy.sh never prints secrets: metadata JSON is built in chmod-600 temp
  files and deleted; live-test transcripts are scrubbed (`Bearer …` → redacted).

## Repo

- GitHub: SuperInstance/quilt-organ-workers (created via API this wave).
- Push discipline: key-scan (gsk_|sk-|ghp_|apikey_|moth_|cfut_) on staged +
  committed trees → set-url with token → push → ls-remote verify remote==local
  → URL scrubbed → credential.helper unset. See git log for what/why/next.
