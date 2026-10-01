#!/usr/bin/env bash
# live-test.sh — end-to-end round-trip against the deployed workers.
# Prints a transcript; secrets are redacted before anything is written.
# Usage: ENV_KEYS=/home/z/my-project/.env.keys scripts/live-test.sh
set -uo pipefail

ENV_KEYS="${ENV_KEYS:-/home/z/my-project/.env.keys}"
# shellcheck disable=SC1090
source "$ENV_KEYS"
: "${WORKER_UPLOAD_TOKEN:?WORKER_UPLOAD_TOKEN missing in $ENV_KEYS}"

BASE_LOADER="https://organ-boot-loader.casey-digennaro.workers.dev"
BASE_JUDGE="https://judge-relay.casey-digennaro.workers.dev"
AUTH=(-H "Authorization: Bearer $WORKER_UPLOAD_TOKEN")
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$ROOT/fixture/greeter-organ.json"

step() { echo; echo "===== $* ====="; }

ID=$(node -e '
import("node:crypto").then(({createHash})=>{
const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
function canonical(v){if(v===null||typeof v!=="object")return JSON.stringify(v);if(Array.isArray(v))return "["+v.map(canonical).join(",")+"]";const ks=Object.keys(v).sort();return "{"+ks.map(k=>JSON.stringify(k)+":"+canonical(v[k])).join(",")+"}";}
console.log(createHash("sha256").update(canonical(b.manifest),"utf8").digest("hex"));
});' "$FIXTURE")

step "1. loader index GET /"
curl -sS "$BASE_LOADER/" | head -c 400; echo

step "2. GET /organs (before upload)"
curl -sS "$BASE_LOADER/organs"; echo

step "3. PUT /organ WITHOUT auth (expect 401)"
curl -sS -o /tmp/lt-401.json -w "HTTP %{http_code}\n" -X PUT -H 'content-type: application/json' --data-binary @"$FIXTURE" "$BASE_LOADER/organ"; cat /tmp/lt-401.json

step "4. PUT /organ with auth (expect 201, id=$ID)"
curl -sS -o /tmp/lt-put.json -w "HTTP %{http_code}\n" -X PUT "${AUTH[@]}" -H 'content-type: application/json' --data-binary @"$FIXTURE" "$BASE_LOADER/organ"; cat /tmp/lt-put.json

step "5. PUT same organ again (content-addressed idempotence)"
curl -sS -o /tmp/lt-put2.json -w "HTTP %{http_code}\n" -X PUT "${AUTH[@]}" -H 'content-type: application/json' --data-binary @"$FIXTURE" "$BASE_LOADER/organ"; cat /tmp/lt-put2.json

step "6. GET /organs (after upload)"
curl -sS "$BASE_LOADER/organs"; echo

step "7. GET /organ/$ID — round-trip byte-compare + headers"
curl -sS -D /tmp/lt-get-headers.txt -o /tmp/lt-get-body.json "$BASE_LOADER/organ/$ID"
grep -iE "^(HTTP|etag|x-quilt-organ-sha256|cache-control|access-control-allow-origin|content-type)" /tmp/lt-get-headers.txt
if cmp -s <(python3 -c "import json,sys;print(json.dumps(json.load(open('/tmp/lt-get-body.json')),sort_keys=True,indent=2),end='')") \
          <(python3 -c "import json,sys;print(json.dumps(json.load(open('$FIXTURE')),sort_keys=True,indent=2),end='')"); then
  echo "ROUND-TRIP: byte-identical (canonical form) ✓"
else
  echo "ROUND-TRIP: MISMATCH ✗"
fi

step "8. GET /organ/$ID/verify (expect bootable:true)"
curl -sS "$BASE_LOADER/organ/$ID/verify"; echo

step "9. negative: tampered state vs stale stateHash (expect 400)"
python3 - "$FIXTURE" > /tmp/lt-tampered.json <<'PYEOF'
import json, sys
b = json.load(open(sys.argv[1]))
b["state"]["cells"]["greet-0"]["last"] = "TAMPERED"
print(json.dumps(b))
PYEOF
curl -sS -o /tmp/lt-tampered-resp.json -w "HTTP %{http_code}\n" -X PUT "${AUTH[@]}" -H 'content-type: application/json' --data-binary @/tmp/lt-tampered.json "$BASE_LOADER/organ"; cat /tmp/lt-tampered-resp.json

step "10. negative: tampered receipt payload (expect 400)"
python3 - "$FIXTURE" > /tmp/lt-tamper2.json <<'PYEOF'
import json, sys
b = json.load(open(sys.argv[1]))
b["receipts"][1]["payload"]["text"] = "forged"
print(json.dumps(b))
PYEOF
curl -sS -o /tmp/lt-tamper2-resp.json -w "HTTP %{http_code}\n" -X PUT "${AUTH[@]}" -H 'content-type: application/json' --data-binary @/tmp/lt-tamper2.json "$BASE_LOADER/organ"; cat /tmp/lt-tamper2-resp.json

step "11. negative: unsupported schemaVersion (expect 400)"
python3 - "$FIXTURE" > /tmp/lt-schema.json <<'PYEOF'
import json, sys
b = json.load(open(sys.argv[1]))
b["schemaVersion"] = "quilt.organ.v9"
print(json.dumps(b))
PYEOF
curl -sS -o /tmp/lt-schema-resp.json -w "HTTP %{http_code}\n" -X PUT "${AUTH[@]}" -H 'content-type: application/json' --data-binary @/tmp/lt-schema.json "$BASE_LOADER/organ"; cat /tmp/lt-schema-resp.json

step "12. GET /organ/0000...0000/verify (expect 404)"
curl -sS -o /tmp/lt-404.json -w "HTTP %{http_code}\n" "$BASE_LOADER/organ/$(printf '0%.0s' $(seq 1 64))/verify"; cat /tmp/lt-404.json

step "13. judge-relay GET /health (no auth)"
curl -sS "$BASE_JUDGE/health"; echo

step "14. POST /judge WITHOUT auth (expect 401)"
curl -sS -o /tmp/lt-j401.json -w "HTTP %{http_code}\n" -X POST -H 'content-type: application/json' \
  -d '{"candidate":"x","rubric":"y","judges":[{"model":"Hermes-3-405B"}]}' "$BASE_JUDGE/judge"; cat /tmp/lt-j401.json

step "15. POST /judge with auth — 1 judge, max_tokens 64 (expect verdict + score)"
curl -sS -o /tmp/lt-judge.json -w "HTTP %{http_code}\n" -X POST "${AUTH[@]}" -H 'content-type: application/json' \
  --data-binary @- "$BASE_JUDGE/judge" <<'JEOF'
{
  "candidate": "Proposal: the quilt-organ bootable bundle format should pin receipt digests in the manifest so a remote agent can verify a saved state chain without re-running the cells.",
  "rubric": "Judge this micro-proposal for (a) soundness: does manifest-pinning of receipt digests actually give remote integrity checking? (b) economy: is it minimal? One short paragraph.",
  "judges": [ {"provider": "deepinfra", "model": "Hermes-3-405B", "max_tokens": 64} ],
  "temperature": 0.2
}
JEOF
cat /tmp/lt-judge.json

step "16. POST /judge with 2 judges (aggregate across models, max_tokens 64)"
curl -sS -o /tmp/lt-judge2.json -w "HTTP %{http_code}\n" -X POST "${AUTH[@]}" -H 'content-type: application/json' \
  --data-binary @- "$BASE_JUDGE/judge" <<'JEOF'
{
  "candidate": "Proposal: organ ids should be sha256(canonicalJSON(manifest)) rather than sha256(full bundle bytes), so the manifest stays the content address while receipts remain re-derivable.",
  "rubric": "Judge for soundness and economy in two sentences. Do the benefits of manifest-addressing outweigh the cost?",
  "judges": [ {"provider": "deepinfra", "model": "Hermes-3-405B", "max_tokens": 64}, {"provider": "deepinfra", "model": "Qwen3.5-397B-A17B", "max_tokens": 64} ],
  "temperature": 0.2
}
JEOF
cat /tmp/lt-judge2.json

step "done"
