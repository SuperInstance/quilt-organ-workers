# receipts/DIALECT-UNIFICATION.md — L15 manifest dialect unification (lane 64-c)

Wave 64, Task 64-c, Part 1. Lesson L15 (fleet-seeds/lode/lessons.jsonl): two lanes
building on the same concept in one wave produced two organ-bundle dialects —
quilt-jev-toolkit `quilt.organ.manifest/v1` vs quilt-organ-workers
`quilt.organ.v1`. Rule: register the schema string + canonical-JSON dialect in
ONE place, validate both implementations against a shared fixture, unify before
external uploaders multiply.

This receipt documents the unification. The registration document is
`schema/organ-manifest.v1.json`; the shared fixture is
`fixture/organ-manifest-v1.json`; the proof harness is
`scripts/validate-dialect.mjs`.

## The registered schema string (ONE place)

```
quilt.organ.manifest/v1
```

carried in `bundle.schema` of the canonical bundle. The legacy worker dialect
`quilt.organ.v1` (carried in `bundle.schemaVersion`) remains ACCEPTED during
transition: every response to a legacy-dialect PUT carries the header
`x-quilt-schema-deprecated: quilt.organ.v1` and a `deprecation` pointer in the
body. `/verify` always reports which dialect a stored organ was served as
(`dialect` field, derived from the stored bytes, cross-checked against stored
metadata).

## Design: the toolkit's law is the canonical law, unmodified

The canonical manifest body is the toolkit's manifest law VERBATIM —
`validateManifest`, `computeManifestHash`, `verifyChain`, `canonicalJson` and
`mintOrganId` from quilt-jev-toolkit (checked out at `ecaf2e4`, imported
unmodified by the harness) accept the canonical fixture. What the canonical
dialect takes from each side:

| concern | from | law |
|---|---|---|
| bundle envelope + store content address | worker (kept) | `organ id = sha256hex(canonicalJSON(manifest))` over the FULL manifest incl. its internal `manifestHash`; server-derived; PUT idempotent |
| manifest body | toolkit (kept) | `schema: "quilt.organ.manifest"`, `schemaVersion: 1`, `organId` name@16hex, per-cell `stateHash`, `edges`, `receiptRange {start,end,count}`, `genesis {seq, prevHash}`, `state.cellsSha256`, `supersedes`, `manifestHash` self-cover |
| whole-state commitment | worker (registered extension) | `manifest.stateHash = sha256hex(canonicalJSON(bundle.state))` |
| receipt chain | toolkit (kept) | `{seq (0-based), op (OBJECT, non-empty `type`, all effect content inside), prev, hash}`; `hash = sha256(canon({seq, op, prev}))`; `GENESIS`-anchored; full window (`receipts.length == receiptRange.count`) |
| canonicalization | toolkit = worker (proven equal) | recursive key-sorted, no whitespace, fail-closed on undefined / NaN / Infinity / bigint / function / symbol |

The legacy dialect's receipt fields (`op` string, sibling `cell`/`payload`,
`digest` over the whole receipt, 1-based seq, `genesis` anchor) map INTO the
canonical form: `op.type` ← op, `op.cell` ← cell, `op.*` ← payload fields,
`digest` → `hash` (now covering everything because the payload lives inside
`op`), seq shifts by −1, `genesis` → `GENESIS`.

## Before / after

BEFORE (wave 63): the store accepted only `quilt.organ.v1`; a toolkit-produced
manifest could not be uploaded (and `validateManifest` rejected worker-shaped
manifests with SCHEMA_DRIFT). Two dialects, no shared fixture, no registration.

AFTER (this lane):
- `schema/organ-manifest.v1.json` — the registration (JSON Schema draft
  2020-12 for the canonical bundle + canonicalization rules + identity laws +
  receipt law + dialect registry).
- `src/organ-boot-loader/worker.js` — PUT accepts canonical (primary) and
  legacy (deprecated, header `x-quilt-schema-deprecated`); `/verify` re-derives
  the full law for each dialect and reports `dialect`; canonical validators are
  NAMED EXPORTS so the harness runs the exact production code.
- `fixture/organ-manifest-v1.json` — the shared fixture (below).
- `scripts/validate-dialect.mjs` — 38/38 checks (below).
- Live: the canonical fixture is uploaded to the store and verified
  `bootable: true` with `dialect: "quilt.organ.manifest/v1"` (below).

The legacy fixture `fixture/greeter-organ.json` is preserved UNTOUCHED as the
transition exemplar (never-delete-data also applies to fixtures).

## The fixture (greeter organ, 2 cells / 3 receipts)

Generated deterministically by `fixture/make-organ-manifest-fixture.mjs`
(fixed `createdAt` 2026-10-02T00:00:00Z; same cell contents and receipt texts
as the wave-63 greeter from `receipts/DEPLOYMENT.md`):

| quantity | value (sha256hex unless noted) |
|---|---|
| fixture bytes sha256 | `6abf46592d775995e4645e8198fe6d21f53deeb704fa99b55f23497379d832ad` |
| organ id (store content address) | `677a3c79cde07ea4628c5326a446ee0719702cb0d476c38a44587dbea3552fcb` |
| manifestHash (self-cover, minus manifestHash) | `c3b614ee2cd6a51e5b6ebc21598b67d506936ce40707a9f92efb79a252f7ae21` |
| stateHash (whole state) | `d827e6a7e17acae83f40b051f98c5963d8a7eb97c402bba4d4346479aac4e736` |
| state.cellsSha256 | `59f6d316355364ec50b75378577423e2a4c4baec0218166e0954a8a211ad74d0` |
| receipt chain (short) | `GENESIS → 0929f26a → 86176b8c → b740cbf1` (tip full: `b740cbf10b03079e3a281561f5666bbfb0a5d5f890383048ad042e2b9c653f21`) |
| organId | `greeter-organ@d889ea55b2e46717` (`material` = whole-state stateHash, registered binding) |

For the before/after: the legacy greeter's store id was
`164015d9bfdd126e8ae36871bb645d37ce6f8475f2b7f42594f3b259b9369636` with
whole-state `4a04728f3c3de9b35fae6a8cc54abe72387d13dfe052af7f3be355456b63026e`
— different bytes by design (different dialect, canonicalization-visible
fields), SAME organ content (2 cells, 3 EFFECT receipts "hello quilt" /
"hello organ" / "hello quilt-organ"). Both remain live and bootable in the
store; the store tracks 3 organs (see receipts/ORGAN-WATCHER.md).

## Harness receipt (scripts/validate-dialect.mjs, exit 0)

```
38/38 checks passed
VERDICT: PASS — BOTH implementations validate the canonical fixture.
```

Coverage, in order:
- toolkit law (unmodified import from ../quilt-jev-toolkit @ ecaf2e4):
  `validateManifest` ok, `computeManifestHash` == carried, `verifyChain` ok
  (tip + count match), `mintOrganId(name, stateHash)` == carried organId,
  canonicalJson round-trip idempotent.
- worker law (named exports of src/organ-boot-loader/worker.js — the EXACT
  production validators): `validateCanonicalBundle` ok; worker-derived organ id
  == toolkit-side recompute; `detectDialect` = canonical string.
- cross-canonicalizer battery: worker `canonical()` ≡ toolkit `canonicalJson()`
  BYTE-IDENTICAL on 76 documents (fixture + parts + edge cases + a
  deterministic pseudo-random corpus).
- fail-closed parity: undefined / NaN / Infinity / −Infinity / bigint THROW in
  BOTH canonicalizers.
- negative controls (each must be rejected by the stated law):
  tampered state value → worker rejects (STATEHASH_MISMATCH; toolkit accepts —
  law division receipted: the toolkit's manifest-only view cannot see bundle
  state); forged receipt op → BOTH reject (hash mismatch); manifest field
  edited → BOTH reject (manifestHash self-cover); unknown envelope schema
  string → `detectDialect` = null; seq discontinuity → BOTH reject; prev-link
  break → BOTH reject; truncated window → worker rejects (full-window law;
  toolkit accepts the sub-chain — law division receipted); per-cell stateHash
  claim wrong → BOTH reject via stale manifestHash, and with an
  attacker-re-signed manifestHash → worker still rejects
  (CELL_STATEHASH_MISMATCH) while the toolkit accepts (it never re-derives
  per-cell hashes — law division receipted).

## Live receipts (organ-boot-loader.casey-digennaro.workers.dev)

First canonical upload (2026-10-02T00:46:40Z):

```
PUT /organ (canonical fixture)   → HTTP 201
x-quilt-schema: quilt.organ.manifest/v1
{ "ok": true, "stored": true, "id": "677a3c79cde07ea4628c5326a446ee0719702cb0d476c38a44587dbea3552fcb",
  "dialect": "quilt.organ.manifest/v1", "cellCount": 2, "receiptCount": 3,
  "stateHash": "d827e6a7..." }

GET /organ/677a3c79.../verify    → HTTP 200
{ "ok": true, "bootable": true, "dialect": "quilt.organ.manifest/v1",
  "reason": "manifest digest == id; manifestHash self-cover holds; sha256(canonicalJSON(state)) == manifest.stateHash; sha256(canonicalJSON(state.cells)) == state.cellsSha256; every cell stateHash re-derives; receipt chain links GENESIS→tip with every hash re-derived (toolkit law)",
  "checks": { "manifestDigestMatchesId": true, "stateHashMatchesState": true,
              "manifestHashSelfCover": true, "cellsSha256MatchesState": true,
              "perCellStateHashes": true, "receiptChain": true, "receiptReason": null } }
```

Transition receipts (legacy dialect, same deploy):

```
PUT /organ (legacy greeter)      → HTTP 200 (idempotent; first upload was wave-63's 201)
x-quilt-schema-deprecated: quilt.organ.v1
{ ... "dialect": "quilt.organ.v1",
  "deprecation": "legacy dialect quilt.organ.v1 is accepted during transition; ..." }

GET /organ/164015d9.../verify    → HTTP 200 { "bootable": true, "dialect": "quilt.organ.v1", ... }
```

Negative controls live (fail-closed): tampered legacy state → 400; forged
legacy receipt digest → 400; unknown schema string → 400
"unsupported schema dialect"; tampered canonical receipt → 400
"RECEIPT_INVALID: receipts[1] hash mismatch: recomputed 4bc36a15..., stored
86176b8c...". Full transcript: `scripts/live-test.sh` output (wave-64 run,
exit 0).

## Deprecation policy

1. NOW: canonical accepted (primary, `x-quilt-schema` response header), legacy
   accepted with `x-quilt-schema-deprecated` + body pointer. `/verify` reports
   the dialect either way. The watcher monitors BOTH dialects under their own
   laws.
2. NEXT (a later wave, not this one): flip legacy to reject-with-410 after the
   fleet's stored legacy organs are re-expressed canonically; the header stays
   until then. No data is ever deleted — legacy organs simply keep serving
   under their dialect with the deprecation marker.

## Repo / discipline receipt

- Commits this lane land in SuperInstance/quilt-organ-workers on top of 2caa24d.
- Toolkit provenance: quilt-jev-toolkit @ ecaf2e4, imported unmodified
  (`TOOLKIT_MANIFEST_MJS` env var can point the harness elsewhere; fail-closed
  if missing).
- Key-scan: staged + committed trees scanned for gsk_|sk-|ghp_|apikey_|moth_|cfut_
  before push — all hits are the receipted benign hash-digest class (64-hex
  fixture digests, safe by construction).
