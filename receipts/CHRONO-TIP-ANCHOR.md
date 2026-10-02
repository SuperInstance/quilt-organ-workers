# CHRONO-TIP ANCHOR — lane `chrono` joins the notary watch (wave-73, lane 73-h)

**Lane:** 73-h (the derived-projection watch) · 2026-10-02 ·
repo `SuperInstance/quilt-organ-workers` (pulled `--ff-only` first) ·
chrono source `SuperInstance/quilt-chrono` @ `d7492d0` (pulled `--ff-only`,
== origin). Every number below re-derived during this lane; nothing from
memory, zero model calls.

## The honest gap, named first

quilt-chrono's LIVE ledger is **runtime-only** — `src/ledger.js` builds
chains in memory / in `receipts/raw/` (gitignored); the repo commits no
live-session ledger. This is the erised-sequencer class (69-f/70-c:
unverifiable rows stay receipted-unverifiable, never fabricated). What IS
committed is a real, sealable, self-consistent chain:

- `examples/tide/outputs/ledger.jsonl` — 547 entries, seq 0..546, the tide
  demo's full session (40 steps, deterministic clock, 0 live calls)
- `examples/tide/outputs/run-receipt.json` — the run's own tip receipt

Per the mission: **anchor the DERIVABLE tip of what IS committed.** The
seal sidecar (`*.chain.jsonl`) is not committed either — but it is *derived
data*: the chain re-derives from the committed ledger by chrono's own law.

## The tip, derived three independent ways (all agree)

**`2feb46bf2b5b806950dd26f71507199b5383239f770884d27449b6582101eea4`** (547 links)

| # | derivation path | law | result |
|---|-----------------|-----|--------|
| 1 | chrono's OWN code (`loadLedger` → `buildChain` → `chainTip`, `src/ledger.js` + `src/seal.js` @ d7492d0) | link = sha256(canonical({seq, op, prev})), genesis `GENESIS`, `verifyChainLinks` ok | `2feb46bf…1eea4`, 547 links, balanced (0 unbalanced writes) |
| 2 | the watcher's NEW standalone dialect (`deriveChronoTip`, `src/organ-watcher/divergence.mjs` — zero shared code with the watched) | same law restated + loadLedger's fail-closed entry checks | `2feb46bf…1eea4`, 547 rows |
| 3 | #2 over a LIVE `raw.githubusercontent.com/SuperInstance/quilt-chrono/main/examples/tide/outputs/ledger.jsonl` fetch (HTTP 200, 120,863 bytes) | same | `2feb46bf…1eea4`, 547 rows |

Cross-check on the second derivable quantity: the committed ledger's
`tipHash()` (sha256 over the canonical jsonl) =
`sha256:cddcbc8d202c272e2c2c9ff598c62b3021d9928e8c1fc34d5256351344436b87`
— **byte-matches** the committed `run-receipt.json`'s `tip_hash` (the run
receipt is honest).

**Class note (why this anchor works):** the committed ledger carries NO
carried hashes, so a tampered VALUE re-derives fine with a DIFFERENT tip —
a fork, not a derivation failure. That is precisely the divergence class
the notaries exist for: corruption detection cannot see it; the anchored
tip does (ADVANCED). Structural breaks (gap / ts-regress / bad op-cause /
unparseable) fail closed inside the derivation (LEDGER_* classes, tested).

## Anchored — both notaries, receipted

Verify-first (L18): the tip was re-derived from genesis by THIS lane (three
ways, above), never copied.

```
POST https://quilt-tip-notary.casey-digennaro.workers.dev/anchor   (Bearer WORKER_UPLOAD_TOKEN, runtime-only)
     {"lane":"chrono","day":"2026-10-02","tip":"2feb46bf…1eea4","note":"wave-73 73-h: …"}
→ 201, anchoredAt 2026-10-02T21:51:36.173Z, prevTipForLane null (lane's first anchor),
  record sha256 62ac3e18bdedbc48458aa36a351d897857f484c9edb691c059dfde986f3ceba0
GET /latest/chrono → 200, integrity:"ok"

POST https://quilt-tip-anchor.casey-digennaro.workers.dev/anchor   (same token law)
     {"chain_id":"chrono","tip":"2feb46bf…1eea4","seq":547,"note":"dual-anchor (wave-73 73-h)…"}
→ 201, at 2026-10-02T21:51:41.695Z, sig 4e6003222c0da7d7…aca1
GET /anchor/chrono/2feb46bf…1eea4 → 200 {"verified":true}
```

seq 547 = the committed ledger's row count (the 68-c/69-f convention).
The two witnesses carry the SAME tip → the lane is dual-witnessed from
birth.

## Watcher delta — the lane is now watched, live

- `src/organ-watcher/divergence.mjs`: `chrono` added to `LANE_CONFIG`
  (github_raw → the committed ledger path) + `deriveChronoTip` (the chrono
  dialect: entry law fail-closed + link law restated; no shared code path).
- Tests: `tests/chrono-dialect.test.mjs` (10 new: cross-law agreement,
  tamper-as-fork → ADVANCED, LEDGER_GAP / TIME_REGRESS / BAD_ENTRY /
  empty fail-closed, LANE_CONFIG registration, MATCH + REGRESSED
  scenarios). Full suite **57/57 green** (47 baseline + 10 new; the
  crosscheck sweep lane-count pin carried its documented L22 update 4→5).
- Deployed: `scripts/deploy-organ-watcher.sh` (same 3-module bundle, cron
  0 * * * * re-asserted). POST /check (21:52:28Z):
  - `chrono` → **MATCH** (current tip re-derived by the worker itself ==
    anchored tip), and **BOTH-MATCH** in the cross-check
    ("2 independent notaries anchored the same tip 2feb46bf… —
    dual-witnessed")
  - qmr1 MATCH / BOTH-MATCH, erised-ft1 MATCH / BOTH-MATCH (untouched, green)
  - z-67a-selftest INDETERMINATE (pre-existing honest no-source state),
    erised-sequencer:anchor-proof NO-ANCHORS (pre-existing, receipted 69-f)
  - fleetHealth: state **healthy**, 0 divergences, 0 disagreements,
    both-matches 4, no-anchors 1.
  Raw sweep + status saved: `tool-results/73h/watcher-check-after-chrono-lane.json`,
  `tool-results/73h/watcher-status-after.json` (workspace).

The wave-73 queue's "(2) notary cross-check adds chrono derived-projection
tips (the seal-interop witness as an anchored lane)" is now live end to
end: a derived series' source chain is anchored outside its patient, and an
hourly watcher re-derives the tip from the committed artifact and compares.
