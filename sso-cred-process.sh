#!/usr/bin/env bash
#
# AWS CLI `credential_process` adapter for the local SSO credential server.
#
# The server (Docker `sso_server` on 127.0.0.1:6789, kept warm by the
# SSO_PREWARM watcher in src/services/sso-prewarm.js) returns snake_case
# JSON. AWS CLI's credential_process protocol requires a specific PascalCase
# shape with `Version: 1`. This script bridges the two.
#
# Wire it in ~/.aws/config:
#   [profile payments_us_production]
#   credential_process = /var/go/src/github.com/Claude-Code-Remote/sso-cred-process.sh payments_us_production
#
# That makes every `aws --profile payments_us_production ...` (and anything
# that picks up the profile via AWS_PROFILE) go through the warmed server
# instead of AWS CLI's own ~/.aws/sso/cache, which goes stale without
# `aws sso login`.
#
# CACHING: AWS CLI invokes credential_process once PER `aws` process (no
# in-CLI caching across separate commands). A multi-step investigation runs
# dozens of `aws` calls, each of which would otherwise re-curl the SSO server
# — and that endpoint occasionally hangs ~120s, so a per-call fetch fails
# intermittently with "Error when retrieving credentials from custom-process"
# (incident Q28PR3EMWZRN48, 2026-06-30). We cache the minted creds to a
# user-private file and reuse them until shortly before expiry, so repeated
# (and fresh-shell) `aws` calls hit the disk cache instead of the network.

set -euo pipefail

PROFILE="${1:-${AWS_PROFILE:-payments_us_production}}"
SSO_URL="${SSO_CREDENTIAL_URL:-http://localhost:6789}"
# Refresh when fewer than this many seconds remain on the cached creds.
MARGIN="${SSO_CRED_CACHE_MARGIN:-600}"
CACHE="${TMPDIR:-/tmp}/.sso-cred-$(id -u)-${PROFILE}.json"

reshape() {
    # stdin: server snake_case JSON -> stdout: credential_process protocol.
    python3 -c '
import json, sys
src = json.loads(sys.stdin.read())
print(json.dumps({
    "Version": 1,
    "AccessKeyId": src["access_key_id"],
    "SecretAccessKey": src["secret_access_key"],
    "SessionToken": src["session_token"],
    "Expiration": src["expiration"],
}))
'
}

# 1) Serve from cache when it is present and not near expiry.
if [ -f "$CACHE" ] && python3 - "$CACHE" "$MARGIN" <<'PY' 2>/dev/null
import sys, json, datetime
cache, margin = sys.argv[1], int(sys.argv[2])
exp = json.load(open(cache)).get("Expiration", "")
t = datetime.datetime.fromisoformat(exp.replace("Z", "+00:00"))
now = datetime.datetime.now(datetime.timezone.utc)
sys.exit(0 if (t - now).total_seconds() > margin else 1)
PY
then
    cat "$CACHE"
    exit 0
fi

# 2) Cache miss/expired: fetch fresh (one retry — the endpoint can blip).
fetch() { curl -sf --max-time 90 "${SSO_URL}/credentials?profile=${PROFILE}&format=json"; }
raw="$(fetch || { sleep 2; fetch; })"
out="$(printf '%s' "$raw" | reshape)"

# 3) Cache atomically with user-only perms, then emit.
umask 077
tmp="$(mktemp "${CACHE}.XXXXXX")"
printf '%s' "$out" > "$tmp"
mv -f "$tmp" "$CACHE"
printf '%s\n' "$out"
