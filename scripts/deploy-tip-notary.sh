#!/usr/bin/env bash
# deploy-tip-notary.sh — deploy src/tip-notary to Cloudflare Workers (wave-67, 67-a).
# Reuses the wave-63/66 REST pattern (no wrangler): PUT /accounts/{account_id}/
# workers/scripts/{name} with multipart metadata + module parts. The notary is a
# 2-MODULE bundle (worker.js imports ./logic.mjs) — both parts go in the same
# multipart upload, exactly like wrangler's module bundle format.
#
# KV: the SHARED quilt-organ-store namespace (the organ store) — anchors live at
# anchor:{lane}:{day} / notary-latest:{lane}, prefixes disjoint from the loader's
# meta:/organ:* and the watcher's watch:*. Same-namespace is the point: the
# organ-watcher reads the anchored tips over the KV binding (worker→worker HTTP
# is platform-blocked; receipts/ORGAN-WATCHER.md F1).
#
# Secrets: CLOUDFLARE_API_TOKEN and WORKER_UPLOAD_TOKEN come from gitignored
# .env.keys; the token is attached as a secret_text binding and never appears here.
set -euo pipefail
ENV_KEYS="${ENV_KEYS:-/home/z/my-project/.env.keys}"
# shellcheck disable=SC1090
source "$ENV_KEYS"
: "${CLOUDFLARE_API_TOKEN:?missing}"
: "${WORKER_UPLOAD_TOKEN:?missing}"
export WORKER_UPLOAD_TOKEN
ACCOUNT_ID="049ff5e84ecf636b53b162cbb580aae6"
API="https://api.cloudflare.com/client/v4"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="quilt-tip-notary"
auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")

V=$(curl -sfS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$API/user/tokens/verify")
echo "token verify: $(echo "$V" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["status"])')"

# shared organ-store namespace (find-or-create across all pages)
KV_ID=$(CF_ACC="$ACCOUNT_ID" CF_TOK="$CLOUDFLARE_API_TOKEN" KV_TITLE="quilt-organ-store" python3 - <<'PYEOF'
import json, os, urllib.request
api="https://api.cloudflare.com/client/v4"; acct=os.environ["CF_ACC"]; tok=os.environ["CF_TOK"]; title=os.environ["KV_TITLE"]
def call(method,path,body=None):
    req=urllib.request.Request(api+path,method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"Authorization":f"Bearer {tok}","content-type":"application/json"})
    with urllib.request.urlopen(req) as r: return json.load(r)
page=1; ns_id=""
while True:
    d=call("GET",f"/accounts/{acct}/storage/kv/namespaces?per_page=100&page={page}")
    for n in d["result"]:
        if n["title"]==title: ns_id=n["id"]; break
    if ns_id or page>=d["result_info"]["total_pages"]: break
    page+=1
if not ns_id: ns_id=call("POST",f"/accounts/{acct}/storage/kv/namespaces",{"title":title})["result"]["id"]
print(ns_id)
PYEOF
)
echo "KV namespace quilt-organ-store (shared) = $KV_ID"

META=$(mktemp /tmp/tipnotary-meta-XXXXXX); chmod 600 "$META"
python3 - "$META" "$KV_ID" <<'PYEOF'
import json, sys
meta = {"main_module": "worker.js", "compatibility_date": "2024-09-23",
        "bindings": [
            {"type": "kv_namespace", "name": "ORGANS", "namespace_id": sys.argv[2]},
            {"type": "secret_text", "name": "WORKER_UPLOAD_TOKEN",
             "text": __import__("os").environ["WORKER_UPLOAD_TOKEN"]},
        ]}
open(sys.argv[1], "w").write(json.dumps(meta))
PYEOF

curl -sfS -X PUT "${auth[@]}" \
  -F "metadata=<${META};type=application/json" \
  -F "worker.js=@$ROOT/src/tip-notary/worker.js;type=application/javascript+module" \
  -F "logic.mjs=@$ROOT/src/tip-notary/logic.mjs;type=application/javascript+module" \
  "$API/accounts/$ACCOUNT_ID/workers/scripts/$NAME" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);assert d['success'],d;print('deployed',d['result']['id'],'modules:',[m['name'] for m in d['result'].get('migration',{}).get('steps',[])] or 'worker.js+logic.mjs')"
rm -f "$META"

curl -sfS -X POST "${auth[@]}" -H 'content-type: application/json' \
  -d '{"enabled":true,"previews_enabled":false}' \
  "$API/accounts/$ACCOUNT_ID/workers/scripts/$NAME/subdomain" >/dev/null

SUB=$(curl -sfS "${auth[@]}" "$API/accounts/$ACCOUNT_ID/workers/subdomain" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['subdomain'])")
echo "quilt-tip-notary: https://$NAME.$SUB.workers.dev"
echo "NOTARY_URL=https://$NAME.$SUB.workers.dev"
