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

set -euo pipefail

PROFILE="${1:-${AWS_PROFILE:-payments_us_production}}"
SSO_URL="${SSO_CREDENTIAL_URL:-http://localhost:6789}"

raw="$(curl -sf --max-time 45 "${SSO_URL}/credentials?profile=${PROFILE}&format=json")"

# Reshape: snake_case -> credential_process protocol (Version 1, PascalCase).
python3 -c '
import json, sys
src = json.loads(sys.stdin.read())
out = {
    "Version": 1,
    "AccessKeyId": src["access_key_id"],
    "SecretAccessKey": src["secret_access_key"],
    "SessionToken": src["session_token"],
    "Expiration": src["expiration"],
}
print(json.dumps(out))
' <<<"${raw}"
