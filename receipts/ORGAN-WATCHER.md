# receipts/ORGAN-WATCHER.md — third worker deployed + live-tested (lane 64-c)

Wave 64, Task 64-c, Part 2 (backlog item 1 from README). organ-watcher: the
fleet's boot-readiness monitor. Deployed via the Cloudflare REST API only (no
wrangler login), same secret discipline as the wave-63 deploy — all credentials
from gitignored `.env.keys`, metadata in chmod-600 temp files, no secrets in
this repo, `bash -x` never used.

- Account id: `049ff5e84ecf636b53b162cbb580aae6`
- URL: **https://organ-watcher.casey-digennaro.workers.dev**
- Deployed: `2026-10-02T00:46:12Z`, redeployed with the final design
  `2026-10-02T00:50:04Z` (see finding F1 below)
- Bindings (verified via `GET /workers/scripts/organ-watcher/settings`):
  `ORGANS` (kv_namespace, the SAME `quilt-organ-store` =
  `cd5a5b7efdaf436287a916230262d726` the loader writes), `WORKER_UPLOAD_TOKEN`
  (secret_text), `LOADER_URL` (plain_text, informational)
- Cron trigger: `0 * * * *` (hourly, free-tier friendly: 24 cycles/day,
  ~2 KV writes per organ + 1 summary row per cycle), verified via
  `GET /workers/scripts/organ-watcher/schedules` →
  `[{"cron":"0 * * * *","created_on":"2026-10-02T00:46:12.73986Z",...}]`

## What a cycle does

1. lists every `meta:*` key in the shared KV (the store's organ ids; never
   deletes, never writes to `organ:`/`meta:` keys),
2. independently re-derives every commitment from the STORED bytes — manifest
   digest == addressed id, whole-state stateHash, receipt chain under the
   organ's OWN dialect law (legacy digest chain vs canonical toolkit chain),
   and for canonical dialect also manifestHash self-cover + cellsSha256 +
   per-cell stateHashes — no code path shared with the loader,
3. writes one `watch:{organId}` row `{id, name, dialect, bootable, checkedAt,
   driftDetected, rederived, reason?}` + one `watch:_lastRun` summary,
4. `GET /status` serves the dashboard (open, CORS *).

`driftDetected`: `true` = stored organ FAILED re-derivation (FINDING — the
bytes are immutable evidence, receipted, never deleted) · `false` =
boot-ready · `null` = indeterminate (dialect unknown).

## Finding F1 — same-account worker→worker fetch on workers.dev is blocked (platform)

The first design called the loader's `GET /organ/{id}/verify` over HTTP (the
mission's "calls the /verify path" option). Live result, both organs:

```
rederived: { manifestDigestMatchesId: true, stateHashMatchesState: true, ... }   ← bytes intact
bootable: null, error: "verify HTTP 404: unparseable", latencyMs: 2              ← service probe impossible
driftDetected: null
```

The loader was fine (external curl of the same URLs → 200 bootable JSON the
whole time). The edge refuses the subrequest: same-account worker→worker
fetches on `*.workers.dev` return an instant (~2 ms) unparseable HTML 404 —
the error-1042 class (workers cannot fetch other workers on workers.dev; the
documented workaround is a custom domain or service bindings). RECEIPTED, not
worked around silently: the deployed design uses the mission's sanctioned
fallback — **re-derive the hashes server-side** — which is strictly stronger
for drift monitoring anyway (the monitor no longer shares the service's code
path, and it still works when the loader itself is down). The loader's /verify
endpoint remains fully live-tested externally (scripts/live-test.sh steps 8/14).

## Forced check cycles (live receipts)

Cycle 1 (00:46:48Z, first design — F1 as above): 2 organs seen (KV list
eventual-consistency: the canonical organ PUT landed 8 s earlier and was not
yet listed), both indeterminate per F1.

Cycle 2 (00:50:20Z, final design, forced via authenticated `POST /check`):

```
{ "ranAt": "2026-10-02T00:50:20.054Z", "trigger": "manual", "durationMs": 2241,
  "organsTracked": 3, "bootable": 3, "drifted": 0, "indeterminate": 0 }
```

## GET /status — the receipted dashboard (2026-10-02T00:51Z)

```json
{
  "ok": true,
  "service": "organ-watcher",
  "loaderUrl": "https://organ-boot-loader.casey-digennaro.workers.dev",
  "method": "independent server-side re-derivation of every stored organ's commitments (manifest digest, stateHash, receipt chain, dialect extras) — no code path shared with the loader",
  "cadence": "hourly (cron 0 * * * *); POST /check with WORKER_UPLOAD_TOKEN forces a cycle",
  "fleetHealth": {
    "organsTracked": 3,
    "bootable": 3,
    "drifted": 0,
    "indeterminate": 0,
    "state": "healthy",
    "lastRun": {
      "ranAt": "2026-10-02T00:50:20.054Z",
      "trigger": "manual",
      "durationMs": 2241,
      "organsTracked": 3,
      "bootable": 3,
      "drifted": 0,
      "indeterminate": 0
    }
  },
  "organs": [
    {
      "id": "164015d9bfdd126e8ae36871bb645d37ce6f8475f2b7f42594f3b259b9369636",
      "checkedAt": "2026-10-02T00:50:18.034Z",
      "dialect": "quilt.organ.v1",
      "name": "greeter-organ",
      "bootable": true,
      "rederived": { "manifestDigestMatchesId": true, "stateHashMatchesState": true, "receiptChain": true },
      "driftDetected": false
    },
    {
      "id": "1e10ff0275abc461cbe9588344cc519962cb1b662a8124a1da41d59a0f49f21b",
      "checkedAt": "2026-10-02T00:50:18.704Z",
      "dialect": "quilt.organ.v1",
      "name": "cell-rewind-organ",
      "bootable": true,
      "rederived": { "manifestDigestMatchesId": true, "stateHashMatchesState": true, "receiptChain": true },
      "driftDetected": false
    },
    {
      "id": "677a3c79cde07ea4628c5326a446ee0719702cb0d476c38a44587dbea3552fcb",
      "checkedAt": "2026-10-02T00:50:19.385Z",
      "dialect": "quilt.organ.manifest/v1",
      "name": "greeter-organ",
      "bootable": true,
      "rederived": { "manifestDigestMatchesId": true, "stateHashMatchesState": true,
                     "manifestHashSelfCover": true, "cellsSha256MatchesState": true,
                     "perCellStateHashes": true, "receiptChain": true },
      "driftDetected": false
    }
  ]
}
```

FLEET HEALTH: 3 organs tracked, 3 bootable, 0 drifted, 0 indeterminate →
`healthy`. Both dialects monitored under their own laws. NO stored organ
failed verification — no drift FINDING to open; the watch rows and this
receipt prove the fleet's organs re-derive byte-clean at deploy time. (Had any
organ failed, this receipt would carry it verbatim and NOTHING would have been
deleted.)

Negative controls live: `POST /check` without auth → 401. `GET /status` needs
no auth (no secrets in it — organ ids are public content addresses).

## Free-tier usage (this lane)

- 3 Workers requests paths exercised (~60 requests total incl. negative
  controls; free cap 100,000/day), cron adds 24 cycles/day.
- KV: +~8 watch-row writes (2 designs × 3 organs + 2 summaries + idempotent
  meta refreshes; cap 1,000/day), reads trivial (cap 100,000/day), watch rows
  ≈ 600 B each (cap 1 GB).
- DeepInfra: live-test judge fan-out re-verification, 2 requests / 3 judges /
  192 completion tokens (max_tokens 64 each; cap honored), estimated ≈ $0.0007.
- Everything else: $0.

## For the next lane

- F1 workaround options if remote /verify probing is ever wanted from a
  worker: custom domain on the loader, or Cloudflare service bindings
  (`env.service.fetch`) — noted, NOT done this wave (re-derivation is the
  better monitor).
- The watcher is the natural alert hook: when `fleetHealth.state` flips to
  `DRIFT-DETECTED`, a pinned status organ / notification lane can read /status
  (open JSON).
- Watch-row history: currently last-check-per-organ (overwrite). If the fleet
  wants drift HISTORY, append `watch:{id}:{checkedAt}` rows later — never
  delete the current rows.
