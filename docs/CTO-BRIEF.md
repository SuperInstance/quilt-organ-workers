# quilt-organ-workers — CTO Brief
> Executive summary for investment decisions. Read time: ~5 minutes.

## One-paragraph value statement
quilt-organ-workers is the fleet's serverless trust layer: four free-tier
Cloudflare Workers that (1) store saved-state bundles ("organs") content-addressed
so anyone can boot them after independent verification, (2) fan candidates out to
judge models from lanes with no local model access, (3) hourly re-derive every
stored organ's integrity commitments and detect both corruption and divergence
against external tip anchors, and (4) anchor receipt-chain tips so tail truncation
of any fleet ledger becomes detectable within an hour. It is live, serving real
traffic, and costs effectively $0.

## What it does & for whom
Consumers are the fleet's own agents first (any lane can boot an organ, judge a
candidate, or anchor a tip without credentials, cloning a repo, or a local
model), and external verifiers second — the Stone standard says a stranger should
be able to verify fleet claims from artifacts alone, and the CORS-open GETs plus
`/verify` re-derivation make exactly that possible over plain HTTP. The four
services: **organ-boot-loader** (upload/list/get/verify organ bundles),
**judge-relay** (up to 8 judges per call, score-first contract, aggregate
verdict), **organ-watcher** (hourly independent re-derivation, divergence delta,
two-notary cross-check, public dashboard), **quilt-tip-notary** (per-lane per-day
anchored tips with per-lane chaining and content-addressed integrity). A fifth
sibling worker (`quilt-tip-anchor`, chain/seq witness with HMAC rows) is deployed
from this repo and cross-checked by the watcher.

## Maturity assessment: **working** (with one hardened subsystem)
- **Evidence of "working"**: deployed 2026-10-01 and continuously live since;
  wave-67/68 probes and this wave's own probes confirm all endpoints respond;
  5/5 stored organs bootable, `fleetHealth.state: healthy`, zero divergences,
  notaryAgreement BOTH-MATCH (live dashboard read during this documentation wave).
- **Receipted live tests**: full round-trips with negative controls
  (`receipts/DEPLOYMENT.md`), tamper-check on an anchor row (500 E_INTEGRITY then
  restored), the divergence alarm firing then clearing
  (`receipts/TIP-NOTARY.md`), dual-anchoring into the second notary
  (`receipts/DUAL-ANCHOR-69F.md`).
- **Local proof suites green**: 30/30, 17/17, 10/10 test modules and the 38/38
  dialect harness (verified on Node v24.21.0 during this wave).
- **Hardened**: the notary/watcher integrity law (fail-closed named errors,
  content-addressed rows re-derived on every read).
- **Not hardened**: no CI, no alerting hook (state flips are visible only on the
  dashboard), no Durable Object coordination yet. This is prototype-grade
  operations around working-grade code.

## Risks
| risk | severity | mitigation status |
|---|---|---|
| Shared single token (`WORKER_UPLOAD_TOKEN`) — any holder can write to all four services | medium | accepted for now; one-token discipline is receipted and was rotated once (wave 67); per-service tokens or Ed25519 signing is the standing upgrade path |
| Secrets model depends on lane-held env vars — a fresh clone cannot deploy | low (by design) | documented honestly; deploys are performed from the credential-owning lane; no credential has ever been committed |
| Cloudflare free-tier / platform behavior (worker→worker fetch blocked; KV list eventual consistency ~60 s) | low | designed around (KV-shared state, re-derivation, PUT-returns-id); both receipted as findings F-class |
| Judge output quality depends on models honoring the SCORE line; budget truncation | low | score-first contract + parsed score + raw text always returned; `n` vs `n_total` exposes partial panels |
| Two independent notaries could disagree (fork detection is the point, but response is manual) | medium | `NOTARY-DISAGREE` alarm exists; automated alert hook is an open backlog item — currently a human/agent must read `/status` |
| Organ store growth beyond list limits (64 shown, 512 watcher cap) | low | fine at fleet scale; indexer/mirror backlog items named |

## Cost profile
Free-tier Cloudflare Workers + KV: receipted usage is orders of magnitude inside
caps (100k requests/day, 1k KV writes/day, 1 GB stored). Judge calls route
through DeepInfra with a receipted ≈ $0.0013 for the first live panel; per-call
budgets are capped by design (max_tokens ≤ 256, ≤ 8 judges). Hosting the same
capability on any paid stack would add cost with no capability gain at current
scale. The only non-trivial future cost is engineering time for the backlog.

## Strategic options
- **Invest (recommended, small)** — land the alert hook + drift-history rows, the
  judge-gauntlet verdict cache, and the organ-boot-bridge Durable Object
  (nesting/lease coordination). These convert a monitoring surface into a
  response capability and unlock two-lane nesting on shared saved state, which
  is the fleet's stated "drop-in nesting" primitive.
- **Maintain** — the system is cheap and stable; hourly cron + receipts keep it
  honest with near-zero ops. If fleet activity stays at current scale this is
  defensible.
- **Harvest-learnings** — the L15 dialect-unification pattern (one registered
  schema + shared fixture + harness over both implementations) and the
  two-notary cross-check pattern are already being copied by other repos; the
  `receipt-primitive` distillation (one {seq, prev, body, id, sig?} law with
  pluggable hash) is the natural next export.
- **Retire** — not indicated: it is live, receipted, and load-bearing for the
  organ and receipt-chain concepts across the fleet.

## Integration surface
- **quilt-jev-toolkit** — upstream of the canonical manifest law; the dialect
  harness validates both implementations against one fixture.
- **quilt-mcp-receipts** — sibling receipt organ; its v2 plan names this repo as
  the HTTP transport + tip-anchoring host (its read/verify/append verbs map 1:1
  onto loader routes).
- **erised-fleet-table / fleet-seeds** — their live chain snapshots (qmr1,
  erised-ft1) are anchored here; `quilt-mcp-receipts` receipts the first external
  producer.
- **quilt-nn, cot-quilt, quilt-chrono, erised-sequencer** — named adoption
  targets for tip anchoring (chrono lane joined the watch in wave 73,
  `receipts/CHRONO-TIP-ANCHOR.md`).
- **superinstance-lab worklog** — the journal of record; lanes cite
  `GET /latest/{lane}` anchors as external witnesses.
