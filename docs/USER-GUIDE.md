# quilt-organ-workers — User Guide
> For any agent or human who wants to store a bootable organ, judge a candidate
> with a model panel, watch fleet organ health, or anchor a receipt-chain tip.

## What you get
Four live, free-tier Cloudflare Workers with open CORS on every route, so a
browser page, a lane script, or another agent can call them from anywhere:

| worker | base URL | what it gives you |
|---|---|---|
| organ-boot-loader | `https://organ-boot-loader.casey-digennaro.workers.dev` | content-addressed store for organ bundles; upload once, anyone can GET + verify before booting |
| judge-relay | `https://judge-relay.casey-digennaro.workers.dev` | fan a candidate out to up to 8 judge models on DeepInfra; get per-judge verdicts + an aggregate score |
| organ-watcher | `https://organ-watcher.casey-digennaro.workers.dev` | hourly independent re-derivation of every stored organ; `GET /status` is the fleet health dashboard |
| quilt-tip-notary | `https://quilt-tip-notary.casey-digennaro.workers.dev` | per-lane, per-day external anchor for any 32-byte receipt-chain tip, with per-lane chaining |

A fifth worker, `quilt-tip-anchor` (`https://quilt-tip-anchor.casey-digennaro.workers.dev`,
chain-id/seq timestamp witness with HMAC-signed rows), is deployed from this
repo's `src/tip-anchor/` into its own KV namespace; it is the notary's sibling,
and belt-and-suspenders custody means posting to both.

## Install
Nothing to install for read paths — `curl` (or any HTTP client) is enough. For
the local proof suites you need Node >= 18 (verified on v24.21.0):

```bash
git clone https://github.com/SuperInstance/quilt-organ-workers
cd quilt-organ-workers
node --test tests/tip-notary.test.mjs tests/divergence.test.mjs tests/crosscheck.test.mjs tests/chrono-dialect.test.mjs
```

## First success in 5 minutes
List the store, pick an organ id, and verify it is bootable — all unauthenticated:

```bash
curl -s https://organ-boot-loader.casey-digennaro.workers.dev/organs
# → {"ok":true,"count":5,"organs":[{"id":"164015d9...","schemaVersion":"quilt.organ.v1",
#      "cellCount":2,"receiptCount":3,"name":"greeter-organ",...}, ...]}
# verified live: count 5 — greeter-organ (legacy), cell-rewind-organ (legacy, 23 cells),
# greeter-organ (canonical quilt.organ.manifest/v1), and two more legacy greeter organs

curl -s https://organ-boot-loader.casey-digennaro.workers.dev/organ/677a3c79cde07ea4628c5326a446ee0719702cb0d476c38a44587dbea3552fcb/verify
# → {"ok":true,"bootable":true,"dialect":"quilt.organ.manifest/v1","checks":{...}}
```

Check the fleet dashboard:

```bash
curl -s https://organ-watcher.casey-digennaro.workers.dev/status | python3 -c "import json,sys; print(json.load(sys.stdin)['fleetHealth']['state'])"
# → healthy      (verified live: 5/5 organs bootable, 0 divergences, notaryAgreement BOTH-MATCH)
```

## Everyday usage

### 1. Upload an organ bundle (auth required)
Build a bundle in the canonical dialect first — read `schema/organ-manifest.v1.json`
and copy `fixture/organ-manifest-v1.json`. Then:

```bash
curl -s -X PUT https://organ-boot-loader.casey-digennaro.workers.dev/organ \
  -H "Authorization: Bearer $WORKER_UPLOAD_TOKEN" \
  -H "content-type: application/json" \
  --data-binary @fixture/organ-manifest-v1.json
# → 201 {"ok":true,"stored":true,"id":"<64hex>","dialect":"quilt.organ.manifest/v1",
#        "paths":{"bundle":"/organ/<id>","verify":"/organ/<id>/verify"}}
# Re-uploading the identical bundle → 200 {"stored":false,"alreadyExisted":true} (content-addressed idempotence)
```
The id is derived server-side as `sha256hex(canonicalJSON(manifest))`; you cannot
choose it, and identical manifests always land on the same id. Limit: 8 MiB per bundle.

### 2. Verify before you boot (the whole point)
```bash
curl -s https://organ-boot-loader.casey-digennaro.workers.dev/organ/<id>/verify
# → {"bootable":true,"reason":"manifest digest == id; manifestHash self-cover holds; ...",
#    "dialect":"quilt.organ.manifest/v1","checks":{"manifestDigestMatchesId":true,...}}
```
Every commitment is recomputed server-side from the stored bytes. A remote agent
checks this BEFORE booting; anything that fails returns a named reason.

### 3. Judge a candidate with a model panel (auth required)
```bash
curl -s -X POST https://judge-relay.casey-digennaro.workers.dev/judge \
  -H "Authorization: Bearer $WORKER_UPLOAD_TOKEN" -H "content-type: application/json" \
  -d '{
    "candidate": "The patch and its rationale go here",
    "rubric": "Soundness of the argument; economy of means.",
    "judges": [{"model":"Hermes-3-405B","max_tokens":64},{"model":"Qwen3.5-397B-A17B"}]
  }'
# → {"ok":true,"aggregate":{"mean":8.5,"min":8,"max":9,"spread":1,"n":2,"n_total":2},
#    "judges":[{"model":"NousResearch/Hermes-3-Llama-3.1-405B","score":8,"content":"SCORE: 8/10 ..."}, ...]}
```
Fleet short names resolve server-side; anything containing `/` passes through
untouched. `max_tokens` defaults to 64 and is hard-capped at 256. Qwen-family
models get `enable_thinking:false` by default so hidden reasoning does not eat
the budget (per-judge `"no_thinking": true|false` overrides). The receipted
wave-63 run measured 1,139 tokens total across 3 judge calls, ≈ $0.0013.

### 4. Anchor a receipt-chain tip (auth required)
```bash
curl -s -X POST https://quilt-tip-notary.casey-digennaro.workers.dev/anchor \
  -H "Authorization: Bearer $WORKER_UPLOAD_TOKEN" -H "content-type: application/json" \
  -d '{"lane":"my-lane","day":"2026-10-02","tip":"<64 lowercase hex = your 32-byte chain tip>","note":"why this anchor"}'
# → 201 {"ok":true,"anchored":true,"record":{"lane":"my-lane","day":"2026-10-02","tip":"...","anchoredAt":"...","prevTipForLane":null,"sha256":"..."}}
curl -s https://quilt-tip-notary.casey-digennaro.workers.dev/latest/my-lane   # anyone can read it back, integrity re-derived
```
Same `{lane,day,tip}` again → 200 (idempotent). Same day, different tip →
`409 E_DAY_CONFLICT` — a chosen scar is never overwritten. Cite
`GET /latest/{lane}` in your worklog as the external witness.

### 5. Force a watcher cycle now (auth required)
```bash
curl -s -X POST https://organ-watcher.casey-digennaro.workers.dev/check \
  -H "Authorization: Bearer $WORKER_UPLOAD_TOKEN"
# → {"ok":true,"forced":true,"summary":{...},"divergence":{...},"crosscheck":{...},"dashboard":{...}}
```
Without a token, just read `GET /status` — the hourly cron keeps it fresh
(last run timestamp is in `fleetHealth.lastRun`).

### 6. Read a lane's anchored history
```bash
curl -s https://quilt-tip-notary.casey-digennaro.workers.dev/anchor/qmr1        # days + latest record
curl -s https://quilt-tip-notary.casey-digennaro.workers.dev/anchor/qmr1/2026-10-02   # one record, sha256 re-derived
```

## Troubleshooting

| symptom | cause | fix |
|---|---|---|
| `GET /organs` does not show the organ you just PUT | KV list is eventually consistent (up to ~60 s, receipted ~90 s) | use the PUT response id directly; re-check the list after a minute |
| `PUT /organ` → 400 "unsupported schema dialect" | bundle is neither `bundle.schema == "quilt.organ.manifest/v1"` nor legacy `bundle.schemaVersion == "quilt.organ.v1"` | emit the canonical dialect; copy `fixture/organ-manifest-v1.json` |
| `PUT /organ` → 400 `STATEHASH_MISMATCH` / `CELL_STATEHASH_MISMATCH` | state bytes do not hash to the manifest's commitments | re-derive hashes with the fleet `canonical()` (key-sorted, no whitespace); never hash raw pretty-printed JSON |
| `PUT /organ` → 400 "body too large" | bundle over the 8 MiB guard | split state; KV itself allows 25 MiB but boots stay lean by law |
| `PUT`/`POST` → 401 "unauthorized" | missing/wrong token, or the worker's secret is unset | present `Authorization: Bearer <WORKER_UPLOAD_TOKEN>` or `x-quilt-token: <token>`; the value lives in the lane's gitignored `.env.keys`, never in the repo |
| Python tooling computes a different anchor `sha256` than the worker | `json.dumps` default escapes non-ASCII (`ensure_ascii=True`) | use `json.dumps(..., ensure_ascii=False, sort_keys=True, separators=(',',':'))` (receipted finding) |
| `POST /anchor` → 409 `E_DAY_CONFLICT` | the lane already has a different tip anchored for that day | correct — the scar holds. Anchor the new tip under the next day; never try to overwrite |
| `POST /anchor` → 400 `E_DAY_FORMAT` for a plausible date | day must be a REAL UTC calendar date (2026-02-30 is rejected) | send a genuine `YYYY-MM-DD` |
| watcher `/status` shows `fleetHealth.state: "DIVERGENCE-DETECTED"` | a lane's current tip disagrees with anchored history (`REGRESSED`/`ADVANCED`/`MISSING-ANCHOR`) or the two notaries disagree (`NOTARY-DISAGREE`) | read the `divergence` and `notaries` arrays; if REGRESSED, your chain's tail was truncated or rewound — investigate the source repo before re-anchoring |
| watcher `/status` shows `DRIFT-DETECTED` | a stored organ failed re-derivation, or an anchor row failed its sha256 (`CORRUPT-ANCHOR`) | the failing organ/row is named; bytes are immutable evidence — find what touched the store |
| deploying organ-watcher or quilt-tip-notary as a single file → worker 1101/crash at boot | those workers are two-module bundles with relative imports | use `scripts/deploy-organ-watcher.sh` / `scripts/deploy-tip-notary.sh` (multipart module upload) |

## FAQ

**Do I need a Cloudflare account to use any of this?** No. All GET routes are public and CORS-open, which is the design intent: any agent anywhere can boot organs, read the dashboard, and verify anchors. You need the shared `WORKER_UPLOAD_TOKEN` only for the four write paths (PUT /organ, POST /judge, POST /check, POST /anchor), and that token is a Worker secret held by the lanes that own the deployment — it is not in this repo.

**Which dialect should I upload?** Always the canonical `quilt.organ.manifest/v1` (bundle.schema carries the string; manifest body is the toolkit law verbatim plus the registered whole-state `stateHash`). The legacy `quilt.organ.v1` is accepted during transition but every legacy PUT response carries `x-quilt-schema-deprecated: quilt.organ.v1`, and `/verify` reports which dialect is stored.

**How fresh is the watcher dashboard?** The cron runs hourly (`0 * * * *` UTC) and `POST /check` forces a cycle; `fleetHealth.lastRun.ranAt` tells you the age of what you are reading. Verdicts are only as fresh as KV list consistency — direct GETs are stable immediately after a write, lists can lag up to ~60 s.

**What is the difference between drift and divergence?** Corruption/drift means re-derivation fails — bytes are broken or tampered (organ failed its hashes, or an anchored row failed `E_INTEGRITY`). Divergence means two honest states disagree — a chain tip regressed or advanced past its anchor, or two independent notaries anchored different tips for the same lane. The watcher reports them as different classes and different `fleetHealth.state` values (`DRIFT-DETECTED` vs `DIVERGENCE-DETECTED`); they are never conflated.

**Why are there two tip notaries?** Two agents built one independently within ~9 hours (wave 66/67 convergence; see `docs/convergence-receipt.md`). The verdict was "BOTH stay": `quilt-tip-anchor` is the chain_id/seq timestamp witness (HMAC-signed, own namespace), `quilt-tip-notary` is the lane/day-chained anchor in the shared organ-store KV. The watcher cross-checks every lane against BOTH and raises `NOTARY-DISAGREE` as the alarm. Post to both for belt-and-suspenders custody.

**What does the judge-relay score contract require?** Each judge is instructed to BEGIN its verdict with `SCORE: <n>/10`; the relay parses that line (0..10) and aggregates `{mean, min, max, spread, n, n_total}`. This score-first contract exists because the first (score-last) deployment had 64-token verdicts truncated before the score appeared — receipted as a defect and fixed the same wave.
