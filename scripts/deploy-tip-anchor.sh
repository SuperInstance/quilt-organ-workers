#!/usr/bin/env bash
# deploy-tip-anchor.sh — deploy src/tip-anchor to Cloudflare Workers (wave-66).
# Reuses the wave-63 REST pattern (no wrangler). Secrets: CLOUDFLARE_API_TOKEN
# and TIPANCHOR_UPLOAD_TOKEN come from gitignored .env.keys; the upload token
# is attached as a secret_text binding and never appears in the repo.
set -euo pipefail
ENV_KEYS="${ENV_KEYS:-/home/z/my-project/.env.keys}"
# shellcheck disable=SC1090
source "$ENV_KEYS"
: "${CLOUDFLARE_API_TOKEN:?missing}"
: "${TIPANCHOR_UPLOAD_TOKEN:?missing}"
export TIPANCHOR_UPLOAD_TOKEN
ACCOUNT_ID="049ff5e84ecf636b53b162cbb580aae6"
API="https://api.cloudflare.com/client/v4"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="quilt-tip-anchor"
auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")

V=$(curl -sfS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$API/user/tokens/verify")
echo "token verify: $(echo "$V" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["status"])')"

# KV namespace for anchors (separate from organ store; append-only by convention)
KV_ID=$(CF_ACC="$ACCOUNT_ID" CF_TOK="$CLOUDFLARE_API_TOKEN" python3 - <<'PYEOF'
import json, os, urllib.request
api="https://api.cloudflare.com/client/v4"; acct=os.environ["CF_ACC"]; tok=os.environ["CF_TOK"]
def call(method,path,body=None):
    req=urllib.request.Request(api+path,method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"Authorization":f"Bearer {tok}","content-type":"application/json"})
    with urllib.request.urlopen(req) as r: return json.load(r)
page=1; ns_id=""
while True:
    d=call("GET",f"/accounts/{acct}/storage/kv/namespaces?per_page=100&page={page}")
    for n in d["result"]:
        if n["title"]=="quilt-tip-anchors": ns_id=n["id"]; break
    if ns_id or page>=d["result_info"]["total_pages"]: break
    page+=1
if not ns_id: ns_id=call("POST",f"/accounts/{acct}/storage/kv/namespaces",{"title":"quilt-tip-anchors"})["result"]["id"]
print(ns_id)
PYEOF
)
echo "KV namespace quilt-tip-anchors = $KV_ID"

META=$(mktemp /tmp/tipanchor-meta-XXXXXX); chmod 600 "$META"
python3 - "$META" "$KV_ID" <<'PYEOF'
import json, sys
meta = {"main_module": "worker.js", "compatibility_date": "2024-09-23",
        "bindings": [
            {"type": "kv_namespace", "name": "ANCHORS", "namespace_id": sys.argv[2]},
            {"type": "secret_text", "name": "WORKER_UPLOAD_TOKEN",
             "text": __import__("os").environ["TIPANCHOR_UPLOAD_TOKEN"]},
        ]}
open(sys.argv[1], "w").write(json.dumps(meta))
PYEOF

curl -sfS -X PUT "${auth[@]}" \
  -F "metadata=<${META};type=application/json" \
  -F "worker.js=@$ROOT/src/tip-anchor/worker.js;type=application/javascript+module" \
  "$API/accounts/$ACCOUNT_ID/workers/scripts/$NAME" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);assert d['success'],d;print('deployed',d['result']['id'])"
rm -f "$META"

curl -sfS -X POST "${auth[@]}" -H 'content-type: application/json' \
  -d '{"enabled":true,"previews_enabled":false}' \
  "$API/accounts/$ACCOUNT_ID/workers/scripts/$NAME/subdomain" >/dev/null

SUB=$(curl -sfS "${auth[@]}" "$API/accounts/$ACCOUNT_ID/workers/subdomain" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['subdomain'])")
echo "quilt-tip-anchor: https://$NAME.$SUB.workers.dev"
echo "ANCHOR_URL=https://$NAME.$SUB.workers.dev"
