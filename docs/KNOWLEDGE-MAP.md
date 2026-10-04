# quilt-organ-workers — Knowledge Map
> The index of indexes: everything deeper than the README, mapped.

## In this repo
- `src/organ-boot-loader/worker.js` — the store: dialect detection, canonical
  + legacy validation (all exported for the harness), content-addressed KV
  layout (`organ:`/`meta:`), PUT/GET/verify routes.
- `src/judge-relay/worker.js` — single-file judge fan-out to DeepInfra;
  `MODEL_ALIASES`, `SCORING_CONTRACT`, score parser, aggregate math.
- `src/organ-watcher/worker.js` — cron `scheduled()` + `runCycle` +
  `statusPayload`; the independent re-derivation laws (`rederiveBoot`,
  `checkCanonicalChain`, `checkLegacyChain`).
- `src/organ-watcher/divergence.mjs` — `divergenceSweep`: per-lane current-tip
  derivation (GitHub raw chain laws, organ_store tips) vs anchored history;
  verdict table MATCH/REGRESSED/ADVANCED/MISSING-ANCHOR/CORRUPT-ANCHOR/INDETERMINATE.
- `src/organ-watcher/crosscheck.mjs` — `crossCheckSweep`, `loadNotaryRows`,
  `fleetAgreement`, `normalizeLaneId` (wave 69-f): the two-notary law.
- `src/tip-notary/logic.mjs` — the notary's pure law: `LANE_RE`, `TIP_RE`,
  `isRealDay`, `anchorSha256`, `selectPrevTip`, `validateAnchorInput`.
- `src/tip-notary/worker.js` — routes + KV layout `anchor:{lane}:{day}`,
  `notary-latest:{lane}`; idempotent re-POST; `E_DAY_CONFLICT`.
- `src/tip-anchor/worker.js` — the wave-66 sibling (chain_id/seq witness,
  HMAC-signed rows, own namespace); kept in-tree as the deployed record.
- `schema/organ-manifest.v1.json` — THE registered dialect: canonicalization
  law, identity laws (store content address, manifest self-cover, organId
  derivation, state commitments), receipt law, fixture provenance.
- `fixture/` — `organ-manifest-v1.json` (canonical fixture, sha256
  `6abf4659…`), `greeter-organ.json` (legacy fixture, preserved), and the two
  deterministic generators.
- `scripts/` — `deploy.sh` (REST-only full deploy), surgical deploys
  (`deploy-organ-watcher.sh`, `deploy-tip-notary.sh`, `deploy-tip-anchor.sh`),
  `live-test.sh` (scrubbed transcript runner), `validate-dialect.mjs` (the L15
  harness, 38 checks).
- `tests/` — `tip-notary.test.mjs`, `divergence.test.mjs` (30/30 together),
  `crosscheck.test.mjs` (17), `chrono-dialect.test.mjs` (10, wave-73 adoption).
- `receipts/` — see "Receipts of record" below.
- `docs/` — `convergence-receipt.md` (pre-existing, wave 68) + the wave-69
  documentation package (this file's siblings).

## Pre-existing docs (before wave-69)
- `README.md` — the load-bearing document: full endpoint tables, canonical
  dialect spec with a worked JSON example, legacy transition rules, auth +
  secret discipline, deploy/test commands, the inventive-uses backlog (5 items,
  2 done), fleet notes. Wave-69 added only the Documentation section at the end.
- `DESIGN`-equivalent: `schema/organ-manifest.v1.json` description field — the
  registration narrative of the L15 unification (why two dialects existed and
  how they merged).
- `docs/convergence-receipt.md` — the twin-notary convergence event (wave 68,
  lane 68-c): timeline of the two independent builds, reconciliation verdict
  "BOTH stay", the crosscheck design, and §9 musings later honestly disagreed
  with by `receipts/DUAL-ANCHOR-69F.md` §3.
- `receipts/*.md` (9 files) — deployment receipts, live-test transcripts,
  findings, and adoption records; itemized below.

## In the fleet
- **quilt-jev-toolkit** — upstream: owns the manifest law (`validateManifest`,
  `computeManifestHash`, `verifyChain`, `canonicalJson`) that the canonical
  dialect registers verbatim; peer checkout required by `scripts/validate-dialect.mjs`.
- **quilt-mcp-receipts** — sibling receipt organ (MCP stdio); downstream of the
  same seal discipline; its v2 plan names this repo as the HTTP host + tip-anchor.
- **erised-fleet-table** — downstream producer: vendors the live qmr1 store
  snapshot and session ledger whose tips are anchored here (`qmr1`, `erised-ft1`).
- **fleet-seeds** — sibling: lesson L15 (dialect unification rule) originated in
  its lode; its census work named the KV-store-unused-for-anchors finding.
- **quilt-tip-anchor's home (Mavis lane, wave 66)** — sibling notary; the
  watcher cross-checks every lane against both.
- **quilt-nn, quilt-qcells, slackwater-quilt** — the three repos whose stated
  tail-truncation limit motivated the notary (adoption targets).
- **quilt-chrono** — downstream adopter: the `chrono` lane joined the notary
  watch (wave 73, `receipts/CHRONO-TIP-ANCHOR.md`).
- **superinstance-lab** — the journal (worklog.md) recording tasks 63-e, 64-c,
  65 (census), 66-d, 67-p (live probes), 68-a.

## In the journal
Grep `SuperInstance/superinstance-lab → worklog.md` for `quilt-organ-workers`.
Task IDs found and what they did:
- **63-e** (wave 63) — created the repo; deployed organ-boot-loader + judge-relay
  via REST; `receipts/DEPLOYMENT.md`; account/KV ids recorded; live round-trips
  + negative controls; the score-first defect found and fixed same wave.
- **64-c / 64-c-r** (wave 64) — L15 dialect unification (schema + fixture +
  harness) and the organ-watcher deployed with hourly cron; finding F1
  (worker→worker fetch platform-blocked → re-derivation design);
  `receipts/DIALECT-UNIFICATION.md`, `receipts/ORGAN-WATCHER.md`.
- **65 / 65-a era** (wave 65) — the organ family decomposition
  (`download/decomposition-atlas/parts/organ/quilt-organ-workers.json`) and the
  quilt-mcp-receipts creation referencing this repo as host.
- **66-d** (wave 66) — qmr1 snapshot vendored; census naming the anchor gap.
- **67-p** (wave 67) — live probes receipted: organ-boot-loader serving 5 organs,
  organ-watcher /status healthy, judge-relay /health (the "fleet still serves"
  line).
- **68-a** (wave 68) — push-wave integration; repo fast-forward-pulled, pushed.
- Later repo-side lanes (receipted in-repo): **67-a** (tip-notary + divergence
  delta), **68-c** (two-notary cross-check), **69-f** (dual anchors + lane-id
  normalization), **73-h** (chrono lane + RD-005 tranche rider).

## Receipts of record
- `receipts/DEPLOYMENT.md` (63-e) — proof the loader + judge-relay deploy and
  behave: 201/200/401/400/404 matrix, byte-identical GET, judge fan-out with
  usage/cost, free-tier census, the `bash -x` incident disclosure.
- `receipts/DIALECT-UNIFICATION.md` (64-c, L15) — why ONE schema string exists;
  before/after dialect mapping and transition policy.
- `receipts/ORGAN-WATCHER.md` (64-c) — watcher deploy + cron verification +
  finding F1 + the first healthy dashboard transcript (3 organs bootable).
- `receipts/TIP-ANCHOR.md` (66) — the sibling notary's deploy (own KV namespace
  `quilt-tip-anchors`), HMAC row law, first external anchor.
- `receipts/TIP-NOTARY.md` (67-a) — this notary's deploy + law + live test table
  (tamper → 500 E_INTEGRITY → restored), the divergence alarm firing/clearing,
  the first two real anchors (qmr1, erised-ft1), the Python canonicalization
  finding, and the token rotation note.
- `receipts/DUAL-ANCHOR-69F.md` (69-f) — dual-anchoring erised-ft1 +
  z-67a-selftest into Mavis's notary; the decision NOT to re-anchor
  `erised-sequencer:anchor-proof` (tip not derivable; re-anchoring would launder
  an unverifiable claim); the lane-id normalization fix.
- `receipts/CHRONO-TIP-ANCHOR.md` + `receipts/RD005-TRANCHE-4.md` (73-h) — the
  chrono lane joining the watch; the RD-005 planning-sha rider.
- `docs/convergence-receipt.md` (68-c) — the twin-notary reconciliation.

## How to search further
```bash
# every named fail-closed error and where it fires
grep -rn "E_[A-Z_]*" src/ | sort
# every receipt that mentions a tamper or integrity failure
grep -rln "tamper\|E_INTEGRITY\|sig-unverifiable" receipts/ docs/
# divergence verdict logic and its tests
grep -n "REGRESSED\|ADVANCED\|MISSING-ANCHOR\|CORRUPT-ANCHOR" src/organ-watcher/divergence.mjs tests/divergence.test.mjs
# KV key-space contracts (who owns which prefix)
grep -rn "PREFIX\|prefix:" src/ | grep -v test
# canonical JSON implementations that must stay byte-identical
grep -rln "function canonical" src/ fixture/ ../quilt-jev-toolkit/src 2>/dev/null
# journal history for this repo
grep -n "quilt-organ-workers" /home/z/my-project/worklog.md
```
