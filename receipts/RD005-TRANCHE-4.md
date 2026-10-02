# RD-005 TRANCHE-4 — the PLANNING.md Rounds 77-81 headline shas (wave-73, lane 73-h)

**Lane:** 73-h (SuperInstance fleet, wave-73, small-infra lane — the
derived-projection watch) · 2026-10-02 · rider over this lane's chrono work,
adopted per the L21 corollary (checks ride loops you already run) and the
wave-73 queue item "(3) RD-005 tranche-4 rider".

**Start state:** RD-005 (wardroom `sideboard/relocated-doubts/LEDGER.md`)
re-registered at fleet scale by the round-4 pilot: tranche 1 (10
most-load-bearing shas, rounds/01-03 + R77/78 headlines) 10/10; rider
tranches 1-3 at the wave-70/71/72 folds 6/6 each. The PLANNING remainder
stayed open.

## Selection rule (so tranche-5 can argue with it instead of guessing)

**Tranche 4 = the 12 lane-headline (first-cited) commit shas of
PLANNING.md Rounds 79-81** — the wave-70/71/72 headline receipts, each the
sole receipt for its lane's claim. This is the only reading of "the shas
cited in Rounds 77-81 headlines" that lands on exactly twelve: Rounds 77/78
headline receipts were tranche-1's declared ground (`rounds/04/bobbin.md`
picks its ten from "rounds/01-03, the ledger's seeded rows, and PLANNING
Rounds 77/78"), so the uncovered span begins at Round 79. Non-commit hashes
in headline bullets were excluded by class, per the pilot's boundary: seals
(`a1adfe6`), chain tips (`3cc4afaf`), and the Ed25519 key fingerprint
(`5c21b070…`) are content addresses, not git shas.

**Method** = the round-4 pilot's, three authenticated GitHub API calls per
cite: (1) `GET /repos/SuperInstance/{repo}` — exists? public? (2)
`GET .../commits/{sha}` — resolves? full sha? date? (3)
`GET .../compare/{sha}...{default_branch}` — ancestor of main? tip?
diverged? 36 calls, run 2026-10-02T21:53:39Z, script
`tool-results/73h/r4-tranche4.mjs` (workspace), raw rows saved beside it
(`rd005-tranche4-rows.json`). Every repo involved is public (`private:
false` on all 8), so the table is re-derivable anonymously.

## The table

| # | round | lane | cite (as published) | repo | full sha | resolves? | vs main tonight | what it receipts |
|---|-------|------|--------------------|------|----------|-----------|-----------------|------------------|
| 1 | R79 | 70-a | `c526e47` | fleet-seeds | `c526e4742149…` (2026-10-02T19:44:50Z) | ✅ 200 | ancestor, tip +9 | M13 LLM leg — P2 PASS, the gradient's free end |
| 2 | R79 | 70-b | `339ba11` | quilt-float | `339ba111a7f8…` (19:33:43Z) | ✅ 200 | ancestor, tip +5 | the float born — synchrony primitive held, zero exchanges honestly |
| 3 | R79 | 70-d | `7dc5ef5` | wardroom | `7dc5ef57b0a4…` (19:06:55Z) | ✅ 200 | ancestor, tip +1 | round-4 revisit RUN; RD-005 row taken |
| 4 | R79 | 70-e | `cfaf99a` | AI-Writings | `cfaf99a70c16…` (18:59:25Z) | ✅ 200 | ancestor, tip +5 | "Frozen Water" — the live freeze as winter |
| 5 | R79 | 70-f | `2828aab` | quilt-atlas | `2828aab7c4c7…` (19:20:48Z) | ✅ 200 | **still main tip** | scout delta — 5,143 repos, 90 DNA records |
| 6 | R80 | 71-a | `37d4368` | quilt-float | `37d436898110…` (20:12:54Z) | ✅ 200 | **still main tip** | the float MET — 6 taught-by cells, chains byte-equal |
| 7 | R80 | 71-b | `e9fa9e2` | fleet-seeds | `e9fa9e2b90aa…` (20:15:49Z) | ✅ 200 | ancestor, tip +6 | M13 gradient CLOSED — P1-P4 ALL PASS |
| 8 | R80 | 71-c | `b970341` | quilt-storefront | `b97034113a2c…` (20:24:01Z) | ✅ 200 | ancestor, tip +2 | GREETER-DEMO-1 — the wrong-joint tell measured |
| 9 | R80 | 71-d | `9e1517f` | quilt-far-shore | `9e1517f4c4f3…` (20:41:41Z) | ✅ 200 | **still main tip** | FARSHORE-R2 — derivative out-detects threshold 3/3 |
| 10 | R80 | 71-e | `3188a01` | AI-Writings | `3188a013f5f9…` (20:00:23Z) | ✅ 200 | ancestor, tip +3 | "Third Agent" — fiction's first fleet-wave piece |
| 11 | R81 | 72-b | `88c6608` | quilt-softjoints | `88c66080f92d…` (21:09:08Z) | ✅ 200 | **still main tip** | GREETER-LAW — the tell as a joint-selection rule |
| 12 | R81 | 72-c | `d7492d0` | quilt-chrono | `d7492d0672ec…` (21:29:12Z) | ✅ 200 | **still main tip** | CHRONO-CALCULUS — sealable derived projections |

**Verdict: 12/12 resolve. 0 rotted.** Every cited commit is still an
ancestor of its repo's current main (`behind_by` 0 across the board —
nothing diverged, nothing orphaned); five are still the tip. Same-day
healthy is expected (these are yesterday's-and-today's waves), but the
rider's job is exactly this: prove the receipts still carry their weight
BEFORE anyone has to trust them blind. 12 shas × 3 calls = 36 API calls,
zero model calls. Nine distinct repos touched, every one `private: false`.

## Near-misses, named for tranche 5 (load-bearing, cut by the twelve-slot budget)

The R77-81 headline shas no tranche has ever re-resolved, after this one:
`76cc7bf` (softjoints R77 68-a), `c4b276d` + `d3ab7bf` (toolkit +
mcp-receipts, R77 68-b), `1ef3418` (organ-workers R77 68-c), `03bdb51`
(atlas R77 68-d — also a rounds/04 near-miss), `d623e70a` (AI-Writings R77
68-e — also a rounds/04 near-miss), `2485f58` (fleet-seeds R77 68-f — also
a rounds/04 near-miss), `aecc5bc` (wardroom R78 69-e), `11e4f2ef`
(fleet-seeds R78 69-d), `8d274fa` (slackwater PyPI note, R78 69-c),
`3fd0ed6` (fleet-seeds R79 70-f second cite), `52998b2` (fleet-seeds R80
71-d second cite), `37ff181` (storefront R81 72-b second cite) — 13 commit
shas. Class exclusions carried forward from the pilot: `6e42966` (a *tag*
cite, its own flavor), ports/endpoints, organ chain tips.
