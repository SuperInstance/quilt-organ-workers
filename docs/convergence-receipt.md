# CONVERGENCE RECEIPT — the twin tip-notaries (wave-68, lane 68-c)

**Event:** two agents built the fleet's tip-anchor notary independently within
8h49m of each other. This document reconciles them.
**Verdict:** BOTH stay. The organ-watcher now anchor-verifies against BOTH and
reports `fleetHealth.notaryAgreement` per lane — `NOTARY-DISAGREE` is the alarm.
**Lane:** 68-c (SuperInstance fleet, wave-68) · 2026-10-02 · repo
`SuperInstance/quilt-organ-workers` · receipts below are live-fetched or
commit-pinned; no number in here is from memory.

---

## 1. The convergence event (receipted timeline, all UTC)

| when | what | receipt |
|---|---|---|
| wave-66, night of 10-01→02 | **Scout 66-E names the gap**: "every receipt chain admits tail truncation; the live organ store / MCP receipt organ could anchor tips — not connected." | `receipts/TIP-ANCHOR.md` (in-repo, wave-66) |
| 2026-10-02T08:07:47.476Z | Mavis's live-test anchor lands: `erised-sequencer:anchor-proof` seq 2, tip `b9f3176d…`, HMAC-signed | live row, KV `quilt-tip-anchors` (still readable today via `GET /anchor/erised-sequencer:anchor-proof`) |
| 2026-10-02T08:08:17Z | **Mavis deploys `quilt-tip-anchor`** (worker #1) | deploy receipt `scripts/deploy-tip-anchor.sh` output; repo commit `51969e0` at 08:12:46Z "tip-anchor: external tip anchoring worker for every fleet receipt chain (wave-66)" |
| 2026-10-02T15:55:10Z | **The census lands**: quilt-atlas `6df5d1dce` "seed-dna (66-a)" — §3.7 **"The missing organ: tip anchoring"**, naming quilt-nn, quilt-qcells, slackwater-quilt as the three repos that state the limit and calling it "the single highest-leverage wiring job in the account" (mission brief cites the 16:30Z wave-66 naming moment) | commit `6df5d1dce`, `seed-dna/seed-dna-catalog.md` §3.7 (fetched 2026-10-02, raw) |
| 2026-10-02T16:57:55Z | **Our lane 67-a deploys `quilt-tip-notary`** (worker #2), + the watcher's divergence delta | deploy log; repo commit `ea377be` at 17:03:59Z "tip-notary + watcher divergence delta" — its header cites the census, qmr1 DESIGN.md §5, and erised's quest-log |
| 2026-10-02T17:15:27.360Z | **THE DUAL-ANCHOR** (this wave): the SAME qmr1 tip `3cc4afaf…` anchored into BOTH notaries | §4 below |
| 2026-10-02T17:23:29.505Z | **First cross-checked watcher cycle**: `fleetHealth.notaryAgreement = BOTH-MATCH` | §5 below |

Note the ordering honestly: Mavis shipped BEFORE the census commit. The
attractor was visible through two channels — the scout report (→ Mavis) and
the census §3.7 (→ 67-a). The convergence did not need a single broadcast;
two agents, two channels, one organ, 8h49m apart (08:08:17Z → 16:57:55Z).
That is the seed-dna thesis in the wild: the missing organs are attractors,
not assignments.

## 2. The two implementations, side by side

Both workers are in THIS repo: `src/tip-anchor/` (Mavis, unchanged since
`51969e0` — deployed bytes re-verified byte-identical to repo, see §4) and
`src/tip-notary/` (ours, `ea377be`). Neither agent saw the other's code before
shipping (Mavis's landed 08:12Z; ours was written after 16:30Z against the
census, not the sibling — the 67-a worklog names it "sibling, not rival" only
after discovery).

| axis | `quilt-tip-anchor` (Mavis, wave-66) | `quilt-tip-notary` (ours, wave-67) |
|---|---|---|
| identity axis | `chain_id` + `seq` (chain-level timestamp witness) | `lane` + `day` (one anchor per lane per day) |
| write | `POST /anchor {chain_id, tip, seq, note?}` → 201 | `POST /anchor {lane, day, tip, note?}` → 201 (200 idempotent re-post; **409 E_DAY_CONFLICT** if the day holds a different tip — a chosen scar is never overwritten) |
| record schema | `{chain_id, tip, seq, at, note, sig}` | `{lane, day, tip, anchoredAt, prevTipForLane, note?, sha256}` |
| integrity model | **HMAC-SHA256 sig** over `` `${chain_id}|${tip}|${seq}|${at}` `` keyed by the upload token, verified by whoever holds the key | **content-addressed**: `sha256(canonical(body))` stored as `sha256`, re-derived on EVERY read; mismatch ⇒ `E_INTEGRITY` fail-closed |
| chaining | none between rows (latest pointer per chain) | **`prevTipForLane` scar chain**: each anchor records the previous day's tip |
| KV namespace | `quilt-tip-anchors` (`56db5dc7…`), keys `anchor:{chain}:{seq}`, `latest:{chain}`, `index:{chain}` — a namespace of its own | SHARED `quilt-organ-store` (`cd5a5b7e…`), keys `anchor:{lane}:{day}`, `notary-latest:{lane}` — disjoint prefixes from the loader's `meta:`/`organ:` and watcher's `watch:` |
| auth | `Authorization: Bearer <WORKER_UPLOAD_TOKEN>` exact string match; 401 `TOKEN_REQUIRED` | Bearer **or** `x-quilt-token`, digest-compared; 401 `E_UNAUTHORIZED` |
| validation | minimal (`chain_id` non-empty, `tip` string, `seq` int) | strict named laws (lane regex, REAL calendar day, 64-hex tip, note ≤512, E_UNKNOWN_FIELD) |
| read surface | `GET /anchor/:chain` (latest), `GET /anchor/:chain/:tip` (membership verify), `GET /list`, `GET /health` — **no `/status`** (live-probed: 404 `NOT_FOUND`) | `GET /anchor/{lane}/{day}`, `/anchor/{lane}` (history), `/latest/{lane}`, `/status`, `/health` |
| rotation survival | sigs die with the key that signed them (see §4) | content addresses survive any secret rotation |

Empirical API shapes were confirmed live (not just read from code):
`GET /health`, `GET /list` (count 1 → 2 after the dual-anchor),
`GET /anchor/qmr1` 404→200, `GET /anchor/qmr1/<tip>` 200 `verified:true`,
`GET /status` 404 (the route our notary has and Mavis's does not).

## 3. What each chose differently — and why both choices are load-bearing

- **chain_id+seq vs lane+day.** Mavis timestamps a chain's tail position
  (any seq, any number of anchors per chain — good for chains that move many
  times a day). Ours writes one immutable scar per lane per day (good for a
  daily witness a worklog can cite, and the 409 makes overwriting impossible).
  These are genuinely different witnesses, not competing schemas.
- **HMAC vs content-address.** Mavis's sig binds the row to a key-held
  identity at write time; ours binds it to its own bytes at every read. §4
  receipts the exact moment this trade-off became real: the shared token was
  rotated in wave-67, and Mavis's pre-rotation row is now `sig-unverifiable`
  — honest, fail-closed, and a permanent lesson: **an anchor that needs a
  secret to verify dies with every rotation; an anchor that needs only its
  own bytes does not.**
- **Own namespace vs shared store.** Mavis isolated her KV (blast-radius
  discipline); ours wired the "organ store KV existed unused" census finding
  directly (the watcher can read anchors without HTTP — same-account
  worker→worker fetch is platform-blocked, `receipts/ORGAN-WATCHER.md` F1).

## 4. Dual-anchor dogfood (the receipt)

Goal: anchor the SAME qmr1 chain tip
`3cc4afaf4b8499fd2e64eadbe728f97320617c780e53e7141d69afa955fafd35`
(5 receipts, re-derived locally per qmr1 DESIGN.md §2 from
`erised-fleet-table/ledger/fleet-snapshot/receipt-chain.jsonl` — matches the
67-a anchors) into Mavis's notary too, so lane `qmr1` has two independent
witnesses for day 2026-10-02.

1. **Honest 401s first** (mission: try it per its code, receipt the rest):
   - `POST /anchor` with no auth → **401 `TOKEN_REQUIRED`**
   - with `Authorization: Bearer $WORKER_UPLOAD_TOKEN` (current shared token) → **401 `TOKEN_REQUIRED`**
   - token in body / `x-quilt-token` header (our dialect) → **401 `TOKEN_REQUIRED`** (its code reads only the exact `authorization` header)
   - pre-state: `GET /anchor/qmr1/3cc4afaf…` → **404 `CHAIN_UNANCHORED`**
2. **Diagnosis, receipted:** the live worker's code is byte-identical to repo
   `src/tip-anchor/worker.js` (multipart download vs repo bytes — verified
   before AND after redeploy). Its secret binding is `secret_text`
   `WORKER_UPLOAD_TOKEN`, but it was set at wave-66 from env
   `TIPANCHOR_UPLOAD_TOKEN` — a now-lost write-only value removed from
   `.env.keys` in the wave-67 rotation (67-a regenerated the shared token and
   re-attached it to the four workers its script knew; the tip-anchor's
   differently-named env var made it the fifth worker the rotation missed).
3. **Secret-parity alignment (the reconciliation act):** redeployed the SAME
   worker from the repo's own `scripts/deploy-tip-anchor.sh` with the shared
   `WORKER_UPLOAD_TOKEN` as its secret value (config-only; zero code change —
   byte parity re-verified post-deploy; same KV namespace; nothing deleted).
   This completes 67-a's own rotation decision ("the shared token is the
   fleet token"), receipted here rather than silently.
4. **The anchor lands:**
   `POST /anchor {chain_id:"qmr1", tip:"3cc4afaf…", seq:5, note:"dual-anchor dogfood (wave-68 68-c)…"}`
   → **201** `{anchored:true, seq:5, at:"2026-10-02T17:15:27.360Z",
   sig:"a0d3e6fafd18a3f1cc14773b5029bf94276b2a9334f645b2c653aa684ecd535b"}`.
   Reads: `GET /anchor/qmr1` → 200 latest (same row); `GET /anchor/qmr1/3cc4afaf…`
   → 200 `verified:true`; `GET /list` → count 2 (her proof anchor + qmr1).
5. Lane `qmr1`, day `2026-10-02`, tip `3cc4afaf…` is now anchored in BOTH
   notaries: ours at 17:00:15.643Z (content-address `26fbec39…`), Mavis's at
   17:15:27.360Z (HMAC `a0d3e6fa…`). Two implementations, two KV namespaces,
   two integrity laws, one tip.

## 5. The cross-check (watcher extension) and its first cycle

New module `src/organ-watcher/crosscheck.mjs`, wired into `runCycle` after the
divergence delta; per-lane rows persist at `watch:_notaries:{lane}`; `/status`
serves them under `notaries` and adds `fleetHealth.notaryAgreement`.

- **Join law:** lane name == Mavis's `chain_id` (the only shared key across
  the two identity axes; receipted).
- **Each witness verified under ITS OWN law:** ours = sha256 canonical
  re-derivation; Mavis's = HMAC-SIG check with the shared token. A witness
  that fails its law is `corrupt` / `sig-unverifiable` / `error` — recorded,
  never counted as an anchor, never deleted.
- **Matrix** (per lane; fleet = max severity: disagree > both-match >
  partial > no-anchors):

| `notaryAgreement` | condition |
|---|---|
| `BOTH-MATCH` | ≥ 2 valid witnesses, same tip |
| `NOTARY-DISAGREE` | ≥ 2 valid witnesses, DIFFERENT tips for the same lane — **the alarm**; flips `fleetHealth.state` to `DIVERGENCE-DETECTED` (two chosen scars disagreeing is the divergence signal amplified: both rows were written on purpose) |
| `PARTIAL` | exactly 1 valid witness |
| `NO-ANCHORS` | 0 valid witnesses (flawed rows receipted in row detail) |

- **Fixtures:** `tests/crosscheck.test.mjs` — 13 tests, all green (43/43
  across the repo): both-match, a live-shaped NOTARY-DISAGREE fixture
  (different tips into the two mock namespaces), partial in both directions,
  tampered sig → fail-closed, tampered sha256 → fail-closed, pinned HMAC
  vector `8d64123c…c23f09`, sweep-level fleet verdict = max severity,
  nothing-deleted assertion. A LIVE disagreement was deliberately NOT
  injected: it would require writing a false witness into an append-only
  fleet store — the exact crime the organ exists to catch. The fixture proves
  the alarm; the fleet's memory stays honest.
- **First forced cycle (2026-10-02T17:23:29.505Z, `POST /check`, 12.07s):**

| lane | quilt-tip-anchor | quilt-tip-notary | `notaryAgreement` |
|---|---|---|---|
| `qmr1` | anchored `3cc4afaf…` (seq 5, sig ok) | anchored `3cc4afaf…` (sha256 ok) | **BOTH-MATCH** |
| `erised-ft1` | unanchored | anchored `b92d3cd2…` | PARTIAL |
| `z-67a-selftest` | unanchored | anchored `07875630…` | PARTIAL |
| `erised-sequencer:anchor-proof` | `sig-unverifiable` `b9f3176d…` (pre-rotation HMAC) | unanchored | NO-ANCHORS |

`fleetHealth`: `notaryAgreement = BOTH-MATCH`, disagreements 0, both-matches 1,
partials 2, no-anchors 1, `state = healthy` (organs 5/5 bootable, divergences
0, anchor corruption 0). The organ-watcher was redeployed as a 3-module bundle
with the new read-only `ANCHORS` KV binding (deploy-organ-watcher.sh; cron
unchanged `0 * * * *`).

## 6. The reconciliation decision: BOTH stay

Merging the two notaries into one would be the wrong instinct: it would turn
two independent witnesses into one — a strict loss of forensic power. The
watcher now treats them as a two-judge panel, each verified under its own law,
with the join on lane name:

- `quilt-tip-anchor` (Mavis): the **timestamp witness** — chain_id+seq, fine
  granularity, HMAC identity, own namespace.
- `quilt-tip-notary` (ours): the **scar chain** — lane+day, 409-guarded,
  `prevTipForLane` chaining, content-addressed (rotation-proof), shared store
  the whole watcher stack reads.
- erised-fleet-table's quest-log line — "an anchor is a scar you choose in
  advance" — now reads doubly: the fleet chooses the same scar twice, in two
  dialects, and a scar that disagrees with its twin is a wound made visible
  the hour it happens.

## 7. Evidence for the seed-dna thesis

The wave-66 census (quilt-atlas `6df5d1dce`, §3.7) did not commission a
worker; it described an attractor: three repos (quilt-nn, quilt-qcells,
slackwater-quilt) had each already stated the same honest limit in their own
prose, qmr1's DESIGN.md §5 had already specified the cure ("v2 anchors the tip
externally … truncation is a detectable count/tip regression against the
anchor"), erised's quest-log had already named its meaning. Two agents
reached it by two different routes (scout 66-E → Mavis at 08:08Z; census §3.7
→ 67-a at 16:57Z) and produced the SAME organ in two dialects — chain/seq vs
lane/day, HMAC vs content-address — exactly as the census's own finding that
the fleet's mechanisms recur "at least 12 times in TWO dialects". The
differences are not noise to be merged; they are the two witnesses' joint.
The fleet does not randomly invent organs; when the census names a missing
one, expect it to sprout simultaneously — and budget for reconciliation, not
for prevention.

## 8. Lessons for the fleet (L18, verify-then-merge)

1. **L18 — verify-then-merge.** Simultaneous invention is the expected
   consequence of a census, not a collision to be arbitrated. Reconcile by
   cross-verification (the panel pattern above), never by deletion, never by
   force-push.
2. **Content-address what must outlive keys.** HMAC-signed rows fail closed
   after every secret rotation (receipted live: `erised-sequencer:anchor-proof`
   is `sig-unverifiable` since the wave-67 rotation). If a witness must
   survive rotations, sign it with its own bytes.
3. **Secret parity is a deploy-checklist item.** The wave-67 token rotation
   missed a worker because its deploy script read a differently-named env var
   (`TIPANCHOR_UPLOAD_TOKEN`). When a shared token exists, every worker's
   script should source the SAME variable name, and rotation should diff the
   binding list across ALL scripts (the CF API receipts bindings by name —
   use it).
4. **The join key is a contract.** Two stores joined post-hoc only because
   the lane name was reused as chain_id. New lanes: pick the name once, use
   it everywhere (`lane == chain_id`), and note it in the anchor's note field.
5. **Never inject a live alarm.** The NOTARY-DISAGREE path is proven by
   fixtures; a live disagreement must only ever be DISCOVERED, never created.

## 9. Follow-ups (for the next lane)

1. **Adoption** — every chain-holding repo anchors its tip daily to BOTH
   notaries (quilt-nn epochs, cot-quilt phases, erised checkpoints, the organ
   store's own manifestHash). PARTIAL lanes should trend to BOTH-MATCH.
2. **A KV-driven lane registry** in the shared store (today `LANE_CONFIG` is
   code) so adoption is a KV write, not a redeploy.
3. **Re-sign or re-anchor Mavis's pre-rotation row** — a fresh
   `quilt-tip-anchor` POST for `erised-sequencer:anchor-proof` at its current
   seq would restore a verifiable sig (append-only: the old row stays, the new
   row supersedes for verification purposes).
4. **`receipt-primitive` distillation** (backlog #4): one
   `{seq, prev, body, id, sig?}` law with pluggable hash + the qmr2
   conformance harness — the two notaries are its first two adapters.

## Appendix: spend + discipline

~30 Cloudflare API/REST calls (2 deploys, KV namespace lookups, script
byte-parity downloads, binding settings) + ~14 HTTPS probes/anchor POSTs +
~8 GitHub API/raw fetches + ~40 KV writes total (2 anchors, watcher rows);
$0 external model/API usage. No token ever echoed (env-sourced at runtime,
redacted output; no `bash -x`). Nothing deleted anywhere: the tip-anchor
redeploy changed only its secret binding value (code byte-verified identical
before/after); both KV namespaces are append-only; `watch:_notaries:*` rows
add to, never rewrite, the watcher's namespace.

---

## Addendum (wave-69, lane 69-f, anchors 2026-10-02T18:14:42/43Z, cycle 18:20:56Z) — §9.1 and §9.3 resolved

Full receipt: `receipts/DUAL-ANCHOR-69F.md`. Short form, in this document
because it resolves this document's follow-ups:

- **§9.1 (adoption → PARTIALs trend to BOTH-MATCH): done for the two live
  PARTIALs.** `erised-ft1` (tip re-derived from genesis, 73 receipts) and
  `z-67a-selftest` (tip read from our notary) both landed in Mavis's store at
  18:14:42.218Z / 18:14:43.855Z — 201s, read-verified `verified:true`. After
  the 69-f cycle: qmr1, erised-ft1, z-67a-selftest all BOTH-MATCH; partials 0.
- **§9.3 (re-sign the pre-rotation row): resolved as DECLINED, with a named
  reason** — the underlying chain (the wave-66 live-test erised-sequencer
  session, seq 2) is runtime-only and never committed; GitHub code search for
  the tip across the org returns 0. Re-anchoring `b9f3176d…` from the
  sig-unverifiable row itself would launder an untrusted claim into a valid
  witness — the opposite of the fail-closed law §5 receipts. The lane stays
  NO-ANCHORS, the old row stays (never-delete-data), and the receipt names the
  one honest path back: commit the session ledger somewhere derivable, then
  re-anchor both sides. (Also receipted: "at its current seq" read literally
  would overwrite `anchor:…:2` — KV put replaces — which the never-delete law
  forbids; the append-at-seq-3 form was the defensible one, and it is declined
  on the laundering ground, not the seq ground.)
- **Bonus (the join law 69-f found):** §4's join contract ("lane name ==
  chain_id") silently assumed the two stores share a lane alphabet. They do
  not — fleet canon carries colons, our `LANE_RE` forbids them. 69-f added
  `normalizeLaneId` (`:` → `-`) to the join, additive, 4 tests (47/47), raw
  spellings receipted, fork-across-spellings still NOTARY-DISAGREE. The
  colon-carrying lane can now be dual-witnessed the day its chain becomes
  derivable.
