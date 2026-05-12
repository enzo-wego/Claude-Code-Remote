#!/usr/bin/env bash
#
# Fetch temporary AWS credentials from the local SSO credential server
# and report Glue crawler status. Pairs with the SSO pre-warm watcher
# (see src/services/sso-prewarm.js).
#
# Usage:
#   ./sso-check.sh                          # default crawler payments-production
#   ./sso-check.sh <crawler-name>           # custom crawler
#   PROFILE=payments_staging ./sso-check.sh # custom profile
#   REGION=ap-southeast-1 ./sso-check.sh    # custom region

set -euo pipefail

PROFILE="${PROFILE:-payments_us_production}"
REGION="${REGION:-us-east-1}"
CRAWLER="${1:-payments-production}"
SSO_URL="${SSO_CREDENTIAL_URL:-http://localhost:6789}"

echo "Fetching SSO credentials (profile=${PROFILE}) from ${SSO_URL}..."
if ! creds="$(curl -sf --max-time 120 "${SSO_URL}/credentials?profile=${PROFILE}&format=export")"; then
    echo "ERROR: failed to fetch credentials from ${SSO_URL}"
    echo "       Check: docker ps | grep sso_server"
    echo "       Check: curl ${SSO_URL}/health"
    echo "       Check: /sso-status on the bot HTTP port"
    exit 1
fi

eval "${creds}"
export AWS_CONFIG_FILE=/dev/null

echo
echo "=== Identity ==="
aws sts get-caller-identity --output table

echo
echo "=== Crawler: ${CRAWLER} (region=${REGION}) ==="
aws glue get-crawler --name "${CRAWLER}" --region "${REGION}" \
    --output table \
    --query 'Crawler.{Name:Name,State:State,LastCrawlStatus:LastCrawl.Status,LastCrawlTime:LastCrawl.StartTime,LastCrawlError:LastCrawl.ErrorMessage}'
