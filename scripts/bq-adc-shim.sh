#!/usr/bin/env bash
#
# bq auth shim — routes BigQuery auth through Application Default Credentials
# (ADC) instead of the gcloud CLI login cred, which the org reauth policy
# expires ~daily. ADC's refresh token is long-lived (survived 4+ months here),
# so this removes the daily `gcloud auth login` chore for every `bq` call
# (health monitor + investigation agents).
#
# Interim measure. Remove this file and revert BQ_HEALTH_COMMAND once the
# claude-bigquery-viewer service-account key is installed. See the
# project_bq_service_account memory and src/services/bq-health.js.
#
# Absolute paths on purpose: works under systemd's minimal PATH too, and
# `exec /usr/bin/bq` (not `bq`) avoids the shim recursing into itself.
TOKEN="$(/usr/bin/gcloud auth application-default print-access-token 2>/dev/null)"
if [ -n "$TOKEN" ]; then
    export CLOUDSDK_AUTH_ACCESS_TOKEN="$TOKEN"
fi
exec /usr/bin/bq "$@"
