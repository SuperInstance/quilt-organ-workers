# tip-anchor — deployment receipt (wave-66)

**Worker:** `quilt-tip-anchor` → https://quilt-tip-anchor.casey-digennaro.workers.dev
**Deployed:** 2026-10-02 (REST upload, no wrangler; `scripts/deploy-tip-anchor.sh`)
**KV:** `quilt-tip-anchors` namespace `56db5dc7ea9a45f480daf666d002a7a5`
**Secret:** `WORKER_UPLOAD_TOKEN` attached at upload as secret_text (value only
in gitignored `.env.keys` as `TIPANCHOR_UPLOAD_TOKEN`, generated fresh this wave).

## Why

Scout 66-E named the gap: "every receipt chain admits tail truncation; the
live organ store / MCP receipt organ could anchor tips — not connected."
tip-anchor is the missing external witness: any fleet ledger (quilt-nn epoch
chains, organ receipts, cot-quilt run ledgers, erised-sequencer sessions,
oracle chains) can now anchor its (chain_id, tip, seq) outside its own repo.
An anchored tip cannot be tail-truncated silently.

## Live test (executed 2026-10-02T08:07Z)

| probe | result |
|---|---|
| GET /health | 200 `{status: ready}` |
| POST /anchor (real erised-sequencer tip, sha256 `b9f3176d…`) | 201, HMAC-signed row |
| GET /anchor/:chain/:tip (real tip) | 200 `verified: true` |
| GET /anchor/:chain/:wrongtip | 404 `TIP_NOT_ANCHORED` |
| POST /anchor without token | 401 `TOKEN_REQUIRED` |
| POST /anchor malformed | 400 `ANCHOR_MALFORMED` |
| GET /list | 200, count=1 (the proof anchor) |

Bug found by the live test itself: URL-encoded chain ids were not decoded on
the read path (`CHAIN_UNANCHORED` on a freshly anchored chain). Fixed with
`decodeURIComponent`, redeployed, re-verified. The test caught it because it
used a chain_id containing a `:` — fleet canon carries a colon by convention.

## Law

KV rows are never deleted (never-delete-data). Anchors are HMAC-SHA256 signed
over `chain_id|tip|seq|at` with the worker secret; anyone can verify a row's
signature given the secret, and anyone can *read* the row without it. This is
a timestamp witness, not a blockchain — the honest scope: it proves the tip
existed at `at` as far as this worker is trusted.

## Who should anchor (next waves)

1. quilt-nn / quilt-attention: anchor `weight_root_sha` at end of training.
2. cot-quilt: anchor the run-1 receipt tip per phase.
3. organ store: loader anchors manifestHash on upload.
4. erised-sequencer: anchor the checkpoint per "chapter".
