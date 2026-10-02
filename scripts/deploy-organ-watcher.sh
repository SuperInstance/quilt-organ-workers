#!/usr/bin/env bash
# deploy-organ-watcher.sh — redeploy ONLY the organ-watcher (wave-67, 67-a).
# The watcher is now a 3-MODULE bundle (worker.js imports ./divergence.mjs — the
# divergence delta — and ./crosscheck.mjs — the two-notary cross-check, wave-68
# 68-c), so it must be uploaded as a multipart module bundle; the cron schedule
# (0 * * * *) is re-asserted unchanged. Surgical counterpart of deploy.sh (which
# deploys all workers and gets the same 3-module watcher).
# Wave-68 (68-c) bindings: ORGANS (shared quilt-organ-store) + ANCHORS (Mavis's
# quilt-tip-anchors namespace, READ-ONLY for the two-notary cross-check).
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
NAME="organ-watcher"
auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")

V=$(curl -sfS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$API/user/tokens/verify")
echo "token verify: $(echo "$V" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["status"])')"

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

ANCHORS_KV_ID=$(CF_ACC="$ACCOUNT_ID" CF_TOK="$CLOUDFLARE_API_TOKEN" KV_TITLE="quilt-tip-anchors" python3 - <<'PYEOF'
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
if not ns_id: raise SystemExit(f"FATAL: KV namespace {title} not found — deploy quilt-tip-anchor (scripts/deploy-tip-anchor.sh) first")
print(ns_id)
PYEOF
)
echo "KV namespace quilt-tip-anchors (Mavis's notary, read-only) = $ANCHORS_KV_ID"

SUB=$(curl -sfS "${auth[@]}" "$API/accounts/$ACCOUNT_ID/workers/subdomain" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['subdomain'])")

META=$(mktemp /tmp/watcher-meta-XXXXXX); chmod 600 "$META"
LOADER_URL="https://organ-boot-loader.${SUB}.workers.dev" python3 - "$META" "$KV_ID" "$ANCHORS_KV_ID" <<'PYEOF'
import json, sys, os
meta = {"main_module": "worker.js", "compatibility_date": "2024-09-23",
        "bindings": [
            {"type": "kv_namespace", "name": "ORGANS", "namespace_id": sys.argv[2]},
            {"type": "kv_namespace", "name": "ANCHORS", "namespace_id": sys.argv[3]},
            {"type": "secret_text", "name": "WORKER_UPLOAD_TOKEN",
             "text": os.environ["WORKER_UPLOAD_TOKEN"]},
            {"type": "plain_text", "name": "LOADER_URL", "text": os.environ["LOADER_URL"]},
        ]}
open(sys.argv[1], "w").write(json.dumps(meta))
PYEOF

curl -sfS -X PUT "${auth[@]}" \
  -F "metadata=<${META};type=application/json" \
  -F "worker.js=@$ROOT/src/organ-watcher/worker.js;type=application/javascript+module" \
  -F "divergence.mjs=@$ROOT/src/organ-watcher/divergence.mjs;type=application/javascript+module" \
  -F "crosscheck.mjs=@$ROOT/src/organ-watcher/crosscheck.mjs;type=application/javascript+module" \
  "$API/accounts/$ACCOUNT_ID/workers/scripts/$NAME" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);assert d['success'],d;print('deployed',d['result']['id'])"
rm -f "$META"

# cron schedule: unchanged, re-asserted (hourly at :00 — free-tier friendly)
curl -sfS -X PUT "${auth[@]}" -H 'content-type: application/json' \
  -d '[{"cron":"0 * * * *"}]' \
  "$API/accounts/$ACCOUNT_ID/workers/scripts/$NAME/schedules" >/dev/null
echo "cron schedule re-asserted for organ-watcher: 0 * * * * (hourly)"

curl -sfS -X POST "${auth[@]}" -H 'content-type: application/json' \
  -d '{"enabled":true,"previews_enabled":false}' \
  "$API/accounts/$ACCOUNT_ID/workers/scripts/$NAME/subdomain" >/dev/null

echo "organ-watcher: https://$NAME.$SUB.workers.dev"
