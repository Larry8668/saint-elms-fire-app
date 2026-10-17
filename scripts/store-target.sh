#!/usr/bin/env bash
# Point the Render uni's vault store (OBJECT_STORE_*) at an S3 endpoint, then redeploy it.
# Session VMs get the store from the uni, so this is the whole swap (laptop MinIO tunnel,
# DigitalOcean Spaces, the sef-minio service, ...). Run the store contract test against the new
# endpoint first (docs/deploy-render.md), and mirror the vaults if the old store has any.
#
#   scripts/store-target.sh                      # print the uni's current OBJECT_STORE_* (secret masked)
#   OBJECT_STORE_SECRET_KEY=... scripts/store-target.sh <endpoint> [access-key] [bucket] [region] [path-style]
#
# Defaults: access key sef-engine, bucket sef-vaults, region us-east-1, path-style true
# (DO Spaces: region e.g. sgp1, path-style false). Needs the Render CLI's login (or RENDER_API_KEY);
# SEF_UNI_SERVICE_ID overrides the lookup of the service named sef-uni.
set -euo pipefail
export DO_NOT_TRACK=1
api=https://api.render.com/v1

token="${RENDER_API_KEY:-}"
[[ -n "$token" ]] || token="$(awk '/^ *key:/ {print $2; exit}' ~/.render/cli.yaml 2>/dev/null)"
[[ -n "$token" ]] || { echo "store-target: no Render token (render login, or RENDER_API_KEY)" >&2; exit 1; }
call() { curl -fsS -H "Authorization: Bearer $token" -H 'Content-Type: application/json' "$@"; }

uni="${SEF_UNI_SERVICE_ID:-}"
[[ -n "$uni" ]] || uni="$(call "$api/services?name=sef-uni&limit=1" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["service"]["id"])')"

if [[ $# -eq 0 ]]; then
  call "$api/services/$uni/env-vars?limit=100" | python3 -c '
import json, sys
for row in json.load(sys.stdin):
    k, v = row["envVar"]["key"], row["envVar"]["value"]
    if k.startswith("OBJECT_STORE_"):
        print(k, "(set)" if k.endswith("SECRET_KEY") else v)'
  exit 0
fi

endpoint="${1%/}"
: "${OBJECT_STORE_SECRET_KEY:?set OBJECT_STORE_SECRET_KEY to the secret of the access key}"
put() {
  local body
  body="$(python3 -c 'import json,sys; print(json.dumps(dict(value=sys.argv[1])))' "$2")"
  call -X PUT "$api/services/$uni/env-vars/$1" -d "$body" >/dev/null
  echo "$1 set"
}
put OBJECT_STORE_ENDPOINT "$endpoint"
put OBJECT_STORE_ACCESS_KEY "${2:-sef-engine}"
put OBJECT_STORE_BUCKET "${3:-sef-vaults}"
put OBJECT_STORE_REGION "${4:-us-east-1}"
put OBJECT_STORE_FORCE_PATH_STYLE "${5:-true}"
put OBJECT_STORE_SECRET_KEY "$OBJECT_STORE_SECRET_KEY"
# A deploy without a commit id gets a 500 from the API here, so pin the branch head explicitly.
read -r repo branch < <(call "$api/services/$uni" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["repo"], d["branch"])')
commit="$(git ls-remote "$repo" "refs/heads/$branch" | cut -f1)"
call -X POST "$api/services/$uni/deploys" -d "{\"commitId\":\"$commit\"}" |
  python3 -c 'import json,sys; print("deploy", json.load(sys.stdin)["id"], "started")'
