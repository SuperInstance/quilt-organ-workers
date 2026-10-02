#!/usr/bin/env bash
# deploy.sh — deploy organ-boot-loader + judge-relay + organ-watcher to Cloudflare Workers via REST API.
#
# Secret discipline:
#   - ALL credentials come from a gitignored .env.keys file (CLOUDFLARE_API_TOKEN,
#     DEEPINFRA_API_KEY, WORKER_UPLOAD_TOKEN). This script contains none.
#   - Secrets are attached as Worker secret_text bindings at upload time — the
#     equivalent of `wrangler secret put` (documented in README.md):
#       wrangler secret put WORKER_UPLOAD_TOKEN   # on organ-boot-loader + judge-relay
#       wrangler secret put DEEPINFRA_KEY         # on judge-relay
#   - The metadata JSON is written to a chmod-600 temp file and removed after upload.
#
# Usage: ENV_KEYS=/home/z/my-project/.env.keys scripts/deploy.sh
set -euo pipefail

ENV_KEYS="${ENV_KEYS:-/home/z/my-project/.env.keys}"
# shellcheck disable=SC1090
source "$ENV_KEYS"
export WORKER_UPLOAD_TOKEN DEEPINFRA_API_KEY CLOUDFLARE_API_TOKEN
: "${WORKER_UPLOAD_TOKEN:?WORKER_UPLOAD_TOKEN missing in $ENV_KEYS (see README: generate and append it there)}"
: "${DEEPINFRA_API_KEY:?DEEPINFRA_API_KEY missing in $ENV_KEYS}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN missing in $ENV_KEYS}"

export CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-049ff5e84ecf636b53b162cbb580aae6}"
export KV_TITLE="quilt-organ-store"
ACCOUNT_ID="$CF_ACCOUNT_ID"
API="https://api.cloudflare.com/client/v4"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEEPINFRA_BASE="https://api.deepinfra.com/v1/openai"
DEEPINFRA_ALIAS_BASE="$DEEPINFRA_BASE" # informational only; kept out of metadata

auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")

# --- 0. verify token ----------------------------------------------------------
V=$(curl -sfS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$API/user/tokens/verify")
echo "token verify: $(echo "$V" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["status"])')"

# --- 1. KV namespace (find by title across ALL pages, or create) ---------------
KV_ID=$(python3 - <<'PYEOF'
import json, os, sys, urllib.request

api = "https://api.cloudflare.com/client/v4"
acct = os.environ["CF_ACCOUNT_ID"]
tok = os.environ["CLOUDFLARE_API_TOKEN"]
title = os.environ["KV_TITLE"]

def call(method, path, body=None):
    req = urllib.request.Request(api + path, method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"Authorization": f"Bearer {tok}", "content-type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)

# find across all pages
page = 1
ns_id = ""
while True:
    d = call("GET", f"/accounts/{acct}/storage/kv/namespaces?per_page=100&page={page}")
    for n in d["result"]:
        if n["title"] == title:
            ns_id = n["id"]
            break
    if ns_id or page >= d["result_info"]["total_pages"]:
        break
    page += 1

if not ns_id:
    ns_id = call("POST", f"/accounts/{acct}/storage/kv/namespaces", {"title": title})["result"]["id"]
    print(f"created KV namespace {title}", file=sys.stderr)
print(ns_id)
PYEOF
)
echo "KV namespace $KV_TITLE = $KV_ID"

# --- helper: metadata temp file (chmod 600, removed after) --------------------
write_meta() { # $1 = file, $2 = main module, $3 = bindings JSON array
  python3 - "$1" "$2" "$3" <<'PYEOF'
import json, sys, os
path, main, bindings = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
meta = {"main_module": main, "compatibility_date": "2024-09-23", "bindings": bindings}
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(meta, f)
PYEOF
}

upload_worker() { # $1 = script name, $2 = main module path, $3 = bindings JSON array, $4+ = extra module paths (bundle parts, uploaded under their basenames)
  local name="$1" src="$2" bindings="$3"; shift 3
  local meta; meta=$(mktemp /tmp/qow-meta-XXXXXX)
  write_meta "$meta" "worker.js" "$bindings"
  local form=( -F "metadata=<${meta};type=application/json" -F "worker.js=@${src};type=application/javascript+module" )
  local extra
  for extra in "$@"; do
    form+=( -F "$(basename "$extra")=@${ROOT}/${extra};type=application/javascript+module" )
  done
  local resp
  resp=$(curl -sfS -X PUT "${auth[@]}" "${form[@]}" \
    "$API/accounts/$ACCOUNT_ID/workers/scripts/$name")
  rm -f "$meta"
  echo "$resp" | python3 -c "import sys,json;d=json.load(sys.stdin);assert d['success'], d; print('deployed', '$name', 'bindings:', sorted(b['name'] for b in d['result'].get('bindings',[])))"
  # enable on the workers.dev subdomain
  curl -sfS -X POST "${auth[@]}" -H 'content-type: application/json' \
    -d '{"enabled":true,"previews_enabled":false}' \
    "$API/accounts/$ACCOUNT_ID/workers/scripts/$name/subdomain" > /dev/null
  echo "subdomain enabled for $name"
}

SUB=$(curl -sfS "${auth[@]}" "$API/accounts/$ACCOUNT_ID/workers/subdomain" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['subdomain'])")

# --- 2. organ-boot-loader (KV + WORKER_UPLOAD_TOKEN) ---------------------------
upload_worker "organ-boot-loader" "$ROOT/src/organ-boot-loader/worker.js" "$(python3 -c "
import json
print(json.dumps([
  {'type':'kv_namespace','name':'ORGANS','namespace_id':'$KV_ID'},
  {'type':'secret_text','name':'WORKER_UPLOAD_TOKEN','text':__import__('os').environ['WORKER_UPLOAD_TOKEN']},
]))")"

# --- 3. judge-relay (WORKER_UPLOAD_TOKEN + DEEPINFRA_KEY + alias) --------------
upload_worker "judge-relay" "$ROOT/src/judge-relay/worker.js" "$(python3 -c "
import json, os
print(json.dumps([
  {'type':'secret_text','name':'WORKER_UPLOAD_TOKEN','text':os.environ['WORKER_UPLOAD_TOKEN']},
  {'type':'secret_text','name':'DEEPINFRA_KEY','text':os.environ['DEEPINFRA_API_KEY']},
  {'type':'secret_text','name':'DEEPINFRA_API_KEY','text':os.environ['DEEPINFRA_API_KEY']},
]))")"

# --- 4. organ-watcher (shared KV + Mavis's anchor KV + WORKER_UPLOAD_TOKEN + LOADER_URL; cron hourly)
# Backlog item 1 (wave 64, 64-c): hourly re-verification of every organ in the
# store + GET /status fleet dashboard. Shares the SAME KV namespace as the
# loader (reads organ bytes, writes only watch:* rows — never deletes).
# Wave 67 (67-a): the watcher gained the divergence delta and is now a 2-module
# bundle (worker.js + divergence.mjs) — it MUST be uploaded as a multipart
# module bundle or the import fails at boot.
# Wave 68 (68-c): 3-module bundle (+ crosscheck.mjs, the two-notary
# cross-check) with a second, READ-ONLY KV binding: ANCHORS = Mavis's
# quilt-tip-anchors namespace (quilt-tip-anchor, wave-66) — each lane is
# anchor-verified against BOTH notaries under each one's own integrity law.
ANCHORS_KV_ID=$(CF_ACC="$ACCOUNT_ID" CF_TOK="$CLOUDFLARE_API_TOKEN" KV_TITLE="quilt-tip-anchors" python3 - <<'PYEOF'
import json, os, urllib.request
api = "https://api.cloudflare.com/client/v4"
acct = os.environ["CF_ACC"]; tok = os.environ["CF_TOK"]; title = os.environ["KV_TITLE"]
def call(method, path, body=None):
    req = urllib.request.Request(api + path, method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"Authorization": f"Bearer {tok}", "content-type": "application/json"})
    with urllib.request.urlopen(req) as r: return json.load(r)
page = 1; ns_id = ""
while True:
    d = call("GET", f"/accounts/{acct}/storage/kv/namespaces?per_page=100&page={page}")
    for n in d["result"]:
        if n["title"] == title: ns_id = n["id"]; break
    if ns_id or page >= d["result_info"]["total_pages"]: break
    page += 1
if not ns_id: ns_id = call("POST", f"/accounts/{acct}/storage/kv/namespaces", {"title": title})["result"]["id"]
print(ns_id)
PYEOF
)
echo "KV namespace quilt-tip-anchors (Mavis's notary, read-only) = $ANCHORS_KV_ID"
upload_worker "organ-watcher" "$ROOT/src/organ-watcher/worker.js" "$(python3 -c "
import json, os
print(json.dumps([
  {'type':'kv_namespace','name':'ORGANS','namespace_id':'$KV_ID'},
  {'type':'kv_namespace','name':'ANCHORS','namespace_id':'$ANCHORS_KV_ID'},
  {'type':'secret_text','name':'WORKER_UPLOAD_TOKEN','text':os.environ['WORKER_UPLOAD_TOKEN']},
  {'type':'plain_text','name':'LOADER_URL','text':'https://organ-boot-loader.'+'$SUB'+'.workers.dev'},
]))")" "src/organ-watcher/divergence.mjs" "src/organ-watcher/crosscheck.mjs"

# cron trigger: hourly at :00 — free-tier friendly (24 cycles/day, ~2 KV writes
# per organ per cycle + 1 summary row).
curl -sfS -X PUT "${auth[@]}" -H 'content-type: application/json' \
  -d '[{"cron":"0 * * * *"}]' \
  "$API/accounts/$ACCOUNT_ID/workers/scripts/organ-watcher/schedules" > /dev/null
echo "cron schedule set for organ-watcher: 0 * * * * (hourly)"

# --- 5. quilt-tip-notary (wave-67, 67-a: shared KV + WORKER_UPLOAD_TOKEN) ------
# Backlog item 4 ("receipt-anchor"): the fleet's external tip notary — per-lane,
# per-day anchored 32-byte tips in the SHARED organ store (anchor:{lane}:{day},
# notary-latest:{lane}), content-addressed, never deleted. 2-module bundle.
upload_worker "quilt-tip-notary" "$ROOT/src/tip-notary/worker.js" "$(python3 -c "
import json, os
print(json.dumps([
  {'type':'kv_namespace','name':'ORGANS','namespace_id':'$KV_ID'},
  {'type':'secret_text','name':'WORKER_UPLOAD_TOKEN','text':os.environ['WORKER_UPLOAD_TOKEN']},
]))")" "src/tip-notary/logic.mjs"

echo
echo "organ-boot-loader: https://organ-boot-loader.$SUB.workers.dev"
echo "judge-relay:       https://judge-relay.$SUB.workers.dev"
echo "organ-watcher:     https://organ-watcher.$SUB.workers.dev"
echo "quilt-tip-notary:  https://quilt-tip-notary.$SUB.workers.dev"
echo "DEPLOY_TS=$(date -u +%FT%TZ)"
