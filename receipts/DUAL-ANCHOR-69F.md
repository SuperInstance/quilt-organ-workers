# DUAL-ANCHOR 69F — the PARTIALs resolved, the stale row receipted (wave-69, lane 69-f)

**Lane:** 69-f (SuperInstance fleet, wave-69, small-infra lane) · 2026-10-02 ·
repo `SuperInstance/quilt-organ-workers` @ 1ef3418 (pulled `--ff-only` before
work; origin==local). Every number below is live-fetched or re-derived during
this lane; nothing from memory.

**Start state** (`GET /status`, watcher `organ-watcher.casey-digennaro.workers.dev`,
last cycle `2026-10-02T18:00:54.237Z` (hourly cron, pre-69f code), saved
`tool-results/69f/watcher-status-before.json`):

| lane | quilt-tip-anchor | quilt-tip-notary | `notaryAgreement` |
|---|---|---|---|
| `qmr1` | anchored `3cc4afaf…` (seq 5) | anchored `3cc4afaf…` | **BOTH-MATCH** |
| `erised-ft1` | unanchored | anchored `b92d3cd2…` (2026-10-02) | PARTIAL |
| `z-67a-selftest` | unanchored | anchored `07875630…` (2026-10-02) | PARTIAL |
| `erised-sequencer:anchor-proof` | `sig-unverifiable` `b9f3176d…` (seq 2, pre-rotation HMAC) | unanchored | NO-ANCHORS |

`fleetHealth`: notaryAgreement BOTH-MATCH, both-matches 1, **partials 2**,
no-anchors 1, disagreements 0, state healthy (organs 5/5 bootable).

---

## 1. `erised-ft1` — dual-anchored into Mavis's notary (201)

Verify-first (L18): the tip was re-derived from genesis by THIS lane, not
copied from the anchor —
`GET https://raw.githubusercontent.com/SuperInstance/erised-fleet-table/main/ledger/session.json`
(HTTP 200, 46,607 bytes) → `deriveErisedTip` (erised-ledger law,
`src/organ-watcher/divergence.mjs`): **`{ok:true, tip:"b92d3cd2e735e8f5fdad0c008446a93667aa4ee0c0a06c4bcb2a3e2bccf5f572", rows:73}`**
— matches our notary's anchor `anchor:erised-ft1:2026-10-02` (17:00:17.746Z)
and the watcher's own MATCH verdict. seq 73 = receipt count (the convention
68-c's qmr1 dual-anchor set: seq = chain row count).

```
POST https://quilt-tip-anchor.casey-digennaro.workers.dev/anchor
Authorization: Bearer $WORKER_UPLOAD_TOKEN   (shared fleet token, runtime-only)
{"chain_id":"erised-ft1","tip":"b92d3cd2…f572","seq":73,"note":"dual-anchor (wave-69 69-f): tip re-derived from genesis (73 receipts, erised-ledger law) and matches quilt-tip-notary anchor:erised-ft1:2026-10-02 (17:00:17.746Z); two independent witnesses, one convergence"}
→ 201 {anchored:true, seq:73, at:"2026-10-02T18:14:42.218Z", sig:"828c9f7e8d3af6eff3be4edb58ae43d47788192b85546fe39134f39621850a57"}
GET /anchor/erised-ft1/b92d3cd2…f572 → 200 verified:true
```

## 2. `z-67a-selftest` — dual-anchored into Mavis's notary (201)

Tip source per mission: our notary's `GET /anchor/z-67a-selftest/2026-10-02`
→ 200, `integrity:"ok"`, tip `07875630776e0430b109e01faa822c4aec83d8eb3274a993a45d66c0f3e51ed7`
(wave-67 67-a live selftest anchor, 16:58:07.168Z; a notary selftest lane with
**no chain source** — the divergence sweep honestly reports it INDETERMINATE).
seq 1 = first witness position of a lane whose only scar is the selftest
anchor itself; the note says exactly that.

```
POST /anchor {"chain_id":"z-67a-selftest","tip":"07875630…1ed7","seq":1,"note":"dual-anchor (wave-69 69-f): mirrors quilt-tip-notary anchor:z-67a-selftest:2026-10-02 (wave-67 selftest anchor, tip read via GET /anchor/z-67a-selftest/2026-10-02 before this POST); notary-lane selftest with no chain source; two independent witnesses for the same scar"}
→ 201 {anchored:true, seq:1, at:"2026-10-02T18:14:43.855Z", sig:"1b6b18282ba7e48bf7ca9efd43de81125678457d7a678e8cb554fcd430c3e178"}
GET /anchor/z-67a-selftest/07875630…1ed7 → 200 verified:true
```

## 3. `erised-sequencer:anchor-proof` — RECEIPTED UNVERIFIABLE, deliberately NOT re-anchored

The mission's condition: add a fresh re-anchored row for day 2026-10-02 **if
the underlying chain tip is derivable**. Verdict: **NOT derivable.** The
investigation, exhaustively:

| probe | result |
|---|---|
| The only record of the tip | Mavis's own row seq 2 (`at` 2026-10-02T08:07:47.476Z, note "wave-66 first external anchor") — the row whose sig cannot verify. The crosscheck's law: sig-unverifiable = "written under an earlier key **or tampered** — not distinguishable without the write-time key". Using it as the tip source would launder an untrusted claim into a valid witness — the exact crime the fail-closed law exists to prevent. |
| GitHub code search, whole org (`b9f3176de28babcec`, authenticated) | **total_count 0** |
| `SuperInstance/erised-fleet-table` tree (15 files, recursive) | no anchor/proof/notary artifact |
| Local `erised-sequencer` clone (v0 `42c6154`, == origin) | chain **runtime-only**: `engine.mjs` builds sessions in memory; the repo commits no session ledger; README's upgrade path names tip-anchoring but no chain is stored |
| Blind 2-op preimage probes (S1-pin prefixes: init+roll, init+set, init+scar) | no match — and unbounded preimage guessing is not derivation, so it stops here |
| `TIP-ANCHOR.md` (wave-66 receipt) | confirms the anchor was "a **real** erised-sequencer tip" from Mavis's 08:07Z live test — a session that existed only in that run's memory; Mavis is an external agent; no worklog entry in this repo records the session's ops |

**Decision: no fresh anchor row carries `b9f3176d…`** — not in Mavis's store,
not in ours. The lane therefore **stays NO-ANCHORS** (mission-sanctioned), the
stale seq-2 row stays untouched (never-delete-data), and this file is its
receipt: the row is honestly sig-unverifiable since the wave-67 token
rotation, its tip cannot be independently derived, and re-anchoring it would
convert an unverifiable claim into a "valid witness" — declined.

Note the honest disagreement with `docs/convergence-receipt.md` §9.3, which
mused that "a fresh quilt-tip-anchor POST for erised-sequencer:anchor-proof at
its current seq would restore a verifiable sig": restoring a verifiable sig is
precisely what would launder the unverifiable tip. (And read literally — a
POST at seq 2 — it would overwrite `anchor:erised-sequencer:anchor-proof:2`,
the historical evidence; KV put replaces, so even the never-delete law forbids
that spelling of the suggestion. An append at seq 3 was the defensible form,
and it is declined for the laundering reason above.) The re-anchor becomes
honest the moment the underlying session is committed somewhere derivable —
e.g. erised-sequencer exporting its live session ledger to the repo — at which
point any lane can re-derive, then re-anchor both sides.

## 4. Watcher fix discovered en route: lane-id normalization (additive, tested)

Our notary's lane law (`LANE_RE`, `src/tip-notary/logic.mjs`) forbids colons;
fleet canon carries them **by convention** (`receipts/TIP-ANCHOR.md`: "fleet
canon carries a colon by convention" — Mavis's own live test caught its read
path on exactly this). Consequence for the crosscheck: the exact-name join
(`lane == chain_id`, receipted 68-c) could never see a colon-carrying lane
dual-witnessed — if this lane is ever re-anchored honestly, its two witnesses
would land as `erised-sequencer:anchor-proof` (Mavis) and
`erised-sequencer-anchor-proof` (ours) and verdict as two PARTIALs forever.

Fix (additive; nothing removed):

- `normalizeLaneId(id)` — `":"` → `"-"`, trim, fail-closed TypeError on
  non-strings; the ONE receipted divergence between the namings, nothing more.
- `crossCheckSweep` groups raw ids by the normalized join key; every witness
  row carries its `rawId`; a single-spelling group keeps the raw name as the
  record's `lane` (byte-compatible with pre-69f rows); a real two-spelling
  merge publishes the normalized name with `rawIds` receipted. Records persist
  under the lane name AND every raw spelling seen (a pre-69f colon-keyed row
  is superseded **in place** — the watcher's own derived view, rewritten every
  cycle by design; organ data and anchor rows are never touched), and
  `loadNotaryRows` dedupes by `lane` keeping the freshest `checkedAt`, so
  `fleetHealth` counts lanes, not key spellings.
- Different tips under different spellings still verdict **NOTARY-DISAGREE** —
  normalization must never hide a fork.

Tests: 4 new (`normalizeLaneId` law incl. fail-closed; the colon+dash SAME-tip
merge → one BOTH-MATCH lane, not two PARTIALs; the colon+dash DIFFERENT-tip
fork → NOTARY-DISAGREE; the pre-69f stale-row supersession). Suite: **47/47**
(43 pre-existing + 4 new, `node --test tests/*.test.mjs`).

## 5. What changed in the fleet stores (append-only accounting)

- KV `quilt-tip-anchors` (Mavis): +2 rows — `anchor:erised-ft1:73`,
  `anchor:z-67a-selftest:1` (+ their `latest:`/`index:` pointers). Nothing
  deleted, nothing overwritten.
- KV `quilt-organ-store` (ours): no new anchor rows this lane; the watcher's
  `watch:_notaries:*` rows rewrite per cycle as always.
- `erised-sequencer:anchor-proof`: zero writes anywhere; receipted here.

## 6. After-state — the forced cycle (`POST /check`, watcher redeployed first)

Watcher redeployed from this repo's `scripts/deploy-organ-watcher.sh` (3-module
bundle incl. the 69-f crosscheck; cron re-asserted `0 * * * *`), then forced:
`POST /check` at `2026-10-02T18:20:56.227Z` (manual, 12.1s, HTTP 200,
saved `tool-results/69f/check-after.json`):

| lane | quilt-tip-anchor | quilt-tip-notary | `notaryAgreement` |
|---|---|---|---|
| `qmr1` | anchored `3cc4afaf…` (seq 5) | anchored `3cc4afaf…` | **BOTH-MATCH** |
| `erised-ft1` | anchored `b92d3cd2…` (seq 73, 18:14:42Z) | anchored `b92d3cd2…` | **BOTH-MATCH** (was PARTIAL) |
| `z-67a-selftest` | anchored `07875630…` (seq 1, 18:14:43Z) | anchored `07875630…` | **BOTH-MATCH** (was PARTIAL) |
| `erised-sequencer:anchor-proof` | `sig-unverifiable` `b9f3176d…` (seq 2) | unanchored (rawId `erised-sequencer-anchor-proof` — the normalized spelling, live) | NO-ANCHORS (receipted-unverifiable, §3) |

`fleetHealth`: notaryAgreement BOTH-MATCH, both-matches **3** (was 1),
**partials 0 (was 2)**, no-anchors 1, disagreements 0, flawedRows 1 (the
receipted stale row), state healthy (organs 5/5 bootable, divergences 0,
anchor corruption 0). The `notaries` rows now carry `rawId` per witness —
the anchor-proof lane's ours-side row shows the normalized spelling, proving
the join law is live.

Token discipline: the shared token was sourced from `.env.keys` at runtime,
never echoed, never written to a file; no `bash -x`; outputs redacted of
credentials by construction (the notaries' responses carry only chain ids,
tips, sigs).

---

## 7. Wave-70 lane 70-c — the ledger hunt re-run; the loop closed honestly (2026-10-02)

**Lane:** 70-c (SuperInstance fleet, wave-70, small lane) · repo pulled
`--ff-only` first (origin==local @ a794c18). Mission: find Mavis's
`erised-sequencer:anchor-proof` session ledger anywhere and, only if found,
commit it on `evidence/ledger`, re-derive, verify from genesis, dual-anchor
both notaries. **Verdict: NOT FOUND — nothing fabricated, nothing
re-anchored, no watcher cycle forced (no store changed); the row stays
receipted-unverifiable.**

The hunt, exhaustively (every probe live this lane):

| probe | result |
|---|---|
| `SuperInstance/erised-sequencer` clone, pulled `--ff-only` (origin==local @ `42c6154`, single commit, tree clean) | 7 committed files (`README.md`, `engine.mjs`, `play.mjs`, `predictions.json`, `presets/three-hearts.json`, `test/pins.mjs`, `viewer.html`) — **no session ledger anywhere**; `engine.mjs` builds chains in memory and only `play.mjs export [file]` writes one, to a caller-supplied path never used in-repo; no `.gitignore`, no stash, `git fsck` clean (no dangling objects) |
| `git ls-remote` on the repo | exactly ONE ref: `refs/heads/main @ 42c6154` — no tags, no PR refs, no other branches |
| GitHub Actions `GET /repos/SuperInstance/erised-sequencer/actions/runs` | `total_count: 0` — no workflow runs ever, so **no CI artifacts can exist** (artifacts endpoint confirms none) |
| GitHub global code search for the FULL tip `b9f3176de28babcec8e0cb5e723e6ee9359fc00c2114088b9c174752ba6c8205` | **`total_count: 0`** |
| Workspace-wide search for the tip (all of `/home/z/my-project`, `.git` included) | every hit is a receipt/narrative/watcher snapshot quoting the **anchor row** (`TIP-ANCHOR.md`, `DUAL-ANCHOR-69F.md`, `docs/convergence-receipt.md`, `tool-results/69f/*`, night-watch prose) — none carries the chain's ops |
| The committed `erised-fleet-table` `ledger/session.json`, re-derived with THIS repo's own `deriveErisedTip` (erised-ledger law) | `{ok:true, tip:"b92d3cd2…f572", rows:73}` — the **erised-ft1** chain, a different chain; byte-searched: **no row references `b9f3176d`**. It is not Mavis's session. |
| Live watcher state at this lane (read-only `GET /status`; cron cycle 19:00:54.407Z) | row unchanged: Mavis side `sig-unverifiable` (seq 2, tip `b9f3176d…c8205`, at 08:07:47.476Z), our side `unanchored`, `notaryAgreement` **NO-ANCHORS**; `fleetHealth` healthy, `notaryNoAnchors: 1`, `notaryFlawedRows: 1`, divergences 0 |

**Chain remains unverifiable; source ledger never committed; row stays
receipted-unverifiable.** The honest path back (§3) is unchanged and still
open: the moment Mavis's 08:07Z session is exported and committed somewhere
derivable — e.g. `erised-sequencer` shipping its live session ledger as
`ledger/session.json` on a branch `evidence/ledger` — any lane can re-derive
with `deriveErisedTip`, verify from genesis, and dual-anchor both notaries in
one pass (quilt-tip-notary `POST /anchor {lane, day}` + quilt-tip-anchor
`POST /anchor {chain_id, tip, seq}`), then force `POST /check` and read the
delta. The 69-f join law (lane-id normalization) is live and waiting for
exactly that day; until the chain source exists, refusing to witness is the
law, not a gap.
