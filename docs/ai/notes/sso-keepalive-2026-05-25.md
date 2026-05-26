# SSO refresh — 90-day hands-off state

> **⚠️ 2026-05-26 update.** The original "laptop `aws sso login` + rsync to
> VPS" flow described below is **DEPRECATED**. It shared the OIDC client_id
> between laptop and VPS, which meant any `aws sso login` on the laptop
> rotated the refresh token via AWS's sliding-token rule and silently
> invalidated the VPS's copy. Confirmed twice in one day on 2026-05-26 — see
> [`sso-prewarm-fail-2026-05-26.md`](sso-prewarm-fail-2026-05-26.md) for
> root-cause + the new device-code-from-inside-`sso_server` re-seed flow.
>
> Also: the headless-Chrome fallback in `get-credentials-lib.sh:get_credentials()`
> was removed the same day, so `/credentials` no longer hangs 120s and
> spams DMs — it fails fast in ~5s. Two local-only VPS patches; see memory
> file `reference_sso_server_local_patches.md` for verification commands.
>
> Filenames + clientIds below are obsolete after the 2026-05-26 09:00 UTC
> re-seed. Current VPS clientId is `dYAU_9itDHe6VtOw8G4UoG...`, registration
> expires ~2026-08-24.

**Last seeded:** 2026-05-25 04:52 UTC (laptop-side `aws sso login`, rsynced to VPS)
**Expected re-seed by:** 2026-08-13 (80 days, buffer before 90-day expiry on 2026-08-23)
**Next-up token files on VPS:**
- `/var/go/src/github.com/wego-infra/sso/.aws/sso/cache/03a4838097501cf6413b08d1737df0131dabecf3.json`
- `/var/go/src/github.com/wego-infra/sso/.aws/sso/cache/4caf05c46f3d7d20828fa9e88f80fcd3da5afb5c.json`

## What the system actually does now

The Slack bot (`claude-remote`, running as the systemd unit) never talks to AWS or Google directly. It hits a local credential server, `sso_server`, on `http://127.0.0.1:6789`. Everything below sits behind that one URL.

```
claude-remote bot ──▶ sso_server (Docker, port 6789)
                       │
                       ├─ reads /root/.aws/sso/cache/*.json
                       │     │
                       │     └─ access token (8h) + refresh token (90d)
                       │        minted on Enzo's laptop, rsynced here
                       │
                       ├─ keepalive loop (~every 30 min)
                       │     calls `aws sso get-role-credentials` to refresh
                       │     the access token before it expires; also
                       │     resets the refresh-token clock when it lands
                       │
                       └─ on /credentials request:
                             1. checks role-cred cache (~11h TTL)
                             2. if expired, calls sso get-role-credentials
                                using the cached access token
                             3. returns export-style env vars
```

Critically: `sso_server` only needs the **refresh token** to live for the whole 90-day window. The keepalive loop calls AWS APIs frequently enough that the access token never goes stale, which in turn means the refresh token's "last used" timestamp keeps moving forward. The headless-Chrome login automation (`mysqto/sso` → browserless) is **not used** in this flow; it only exists as a fallback that's currently broken.

## How to tell if it's still healthy

Run on the VPS:

```bash
# 1. cache files present and recent?
ls -la /var/go/src/github.com/wego-infra/sso/.aws/sso/cache/

# 2. /credentials returns in seconds, not minutes?
time curl -sf -m 30 "http://localhost:6789/credentials?profile=payments_us_production&format=export" | head -1

# 3. STS confirms the assumed role?
eval "$(curl -sf "http://localhost:6789/credentials?profile=payments_us_production&format=export")"
AWS_CONFIG_FILE=/dev/null aws sts get-caller-identity
# expect: Account=058264138250, Arn ends in PaymentsProdDevRole/enzo@wego.com

# 4. keepalive logged recently? (look for "Keepalive: credentials valid")
docker logs --since 1h sso_server 2>&1 | grep -i keepalive | tail -5

# 5. prewarm not failing? (look for "SSO pre-warm FAIL" — should be ABSENT
#    since the seed time above. Success path logs at debug level and is
#    silent under the default LOG_LEVEL, so quiet = good)
journalctl -u claude-remote --since "6h ago" | grep -i SsoPrewarm | tail -5
```

## What "broken" looks like — debugging map

| Symptom | Likely cause | First check |
|---|---|---|
| `/credentials` hangs ~120s, returns 500 | Refresh token expired (90 days elapsed) → server tried the broken headless-Chrome fallback | `docker logs sso_server` for `SSO login failed` / `context deadline exceeded` |
| `/credentials` returns but `aws sts` says `InvalidClientTokenId` | Access token corrupt / out of sync | Re-seed (see "How to re-seed" below) |
| `/credentials` returns `ExpiredToken` mid-use | Server handed out near-expired role creds (commit `1421bbe` fixed this) | Confirm the running image is built from `ff82b1e` or later: `docker images sso --format '{{.ID}} {{.CreatedAt}}'` |
| Bot's prewarm `WARN: SSO pre-warm FAIL: payments_us_production timeout after 120000ms` shows up again in `journalctl` | Almost always = refresh token expired | Re-seed |
| Datadog/Athena Slack reports say "Account 058264138250 + PaymentsProdDevRole" but timeline data is empty | Probably NOT an SSO issue — check Athena crawler / partition freshness |

### Important: laptop-side Claude already wrote a self-contained runbook

`/var/go/src/github.com/wego-infra/sso/seed-from-laptop.md` — a fresh agent on Enzo's laptop can execute it end-to-end without context. **That's the canonical "fix it" document** for token expiry.

## How to re-seed (the actual fix when expired)

Exactly two commands on Enzo's laptop. Full version in `seed-from-laptop.md`; the short version:

```bash
# On laptop (need [sso-session wego] in ~/.aws/config — set once on 2026-05-25)
aws sso login --sso-session wego

# Sync to VPS
rsync -av ~/.aws/sso/cache/ \
  enzo@172.245.26.77:/var/go/src/github.com/wego-infra/sso/.aws/sso/cache/
```

That's it. No restart, no docker action. The keepalive loop reads the new cache on its next tick (≤30 min) and resumes.

## Why not fix the headless Chrome path?

We tried. See git history `enzo-wego/sso` commits `8064c8a` and `ff82b1e` (May 25) — those landed a persistent `/data` profile so Chrome cookies survive between runs. The change is deployed and correct. But Google's adaptive auth still silently rejects the email-fill on the **first** login from a fresh profile (the field gets cleared with a stray "n" char — visible in `sso_server`'s `screenshots/000026_google_login_email_page_next_after_wait_*.png`), so the seed never lands.

Could be fixed with cookie injection or DevTools-tunneled manual login (see the abandoned `seed-google.sh` script for the latter). But neither is **load-bearing** — the rsync approach is strictly simpler, doesn't fight Google's risk engine, and exactly matches the design Lei described in the original Slack thread (`C0B1BR522F5/p1779418404149049`).

If a future Claude wants to revive headless: the bug is in `sso/sso.go:350` (`data-initial-value` is the wrong attribute; should be the live `value` property). But fixing that alone won't solve the Next-button silent-reject — Google would need cookies in `/data` first, and we have no fully-automated way to plant them.

## What the same fix covers (database, etc.)

The 90-day refresh token mints **role credentials for every profile under sso-session `wego`**. So this same seed also keeps these working:

| Profile | Role | What uses it |
|---|---|---|
| `payments_us_production` | `PaymentsProdDevRole` | Athena queries, ECS/Glue inspection, `pay-ops-production` skill |
| `payments_us_staging` | `PaymentsStageDevRole` | Staging variants of above |
| `blackhole_us_production` | `BlackholeProductionUsDevRole` | `sshuttle` VPN tunnel for prod DB access |
| `db_access_us_production` | `PaymentsDBAccessProdRole` | RDS IAM auth token (`aws rds generate-db-auth-token`) → `psql` to prod DB |
| `db_access_us_staging` | `PaymentsDBAccessStageRole` | Staging DB |
| `secrets_us_production` | `PaymentsSecretManagerRole` | Secrets Manager lookups |

All listed in `/var/go/src/github.com/wego-infra/sso/sso-config.json`. **All re-seed via a single `aws sso login --sso-session wego` on the laptop** — there is no separate "DB token seed."

## Files we touch on the VPS

| Path | What it does | Persistence |
|---|---|---|
| `/var/go/src/github.com/wego-infra/sso/docker-compose.yml` | Defines `browserless_chrome`, `browserless_chromium`, `sso`, `sso_server` containers | Git-tracked in `wego-infra` |
| `/var/go/src/github.com/wego-infra/sso/Dockerfile` | `sso_server` image. Pins `SSO_VERSION=ff82b1e...` from `enzo-wego/sso` (May 25 patch). | Git-tracked |
| `/var/go/src/github.com/wego-infra/sso/get-credentials-lib.sh` | Shell HTTP server inside `sso_server`. Handles cache, keepalive, the broken headless fallback | Git-tracked |
| `/var/go/src/github.com/wego-infra/sso/sso-config.json` | Profile → account/role map. Bind-mounted to `/config/sso-config.json` | Git-tracked |
| `/var/go/src/github.com/wego-infra/sso/.sso.env` | `SSO_EMAIL`, `SSO_PASSWORD`, `SSO_OTP_SECRET`, `BROWSER_MODE`. Only used by the (broken, fallback) headless flow. **Not** required for the rsync seed | Local, gitignored |
| `/var/go/src/github.com/wego-infra/sso/.aws/sso/cache/*.json` | **The actual SSO tokens.** Synced from laptop. Bind-mounted to `/root/.aws/sso/cache/` inside container | Local, gitignored, expires every 90 days |
| `/var/go/src/github.com/wego-infra/sso/seed-from-laptop.md` | Step-by-step runbook for the laptop-side Claude. **Canonical "fix the SSO" doc** | Local |
| `/var/go/src/github.com/wego-infra/sso/seed-google.sh` | Abandoned ephemeral-DevTools approach. Kept as reference, not used | Local |
| `/tmp/sso-backup-20260420/.google-chrome/` | Persistent userDataDir for browserless Chrome (filled when headless attempts run). Currently unused | Local, host-owned by uid 999 (`blessuser`) |

**`/home/enzo/.aws/config`** also exists but is unrelated to `sso_server` — only used for ad-hoc `aws` commands run as the `enzo` user on the VPS. Had a broken `[default]` block on 2026-05-25, deleted same day.

## VPS quick-reference

- IP: `172.245.26.77`
- SSH user: `enzo`
- `sso_server`: port `127.0.0.1:6789`
- `sso_server` container: `sso_server` (`sso:latest` image, rebuilt 2026-05-25 03:22 UTC from `enzo-wego/sso@ff82b1e`)
- Browserless: `browserless_chrome` container, NOT exposed to host
- `claude-remote` service: `systemctl status claude-remote`, port `127.0.0.1:9999` (HTTP), main log `journalctl -u claude-remote`

## Pointers if Enzo says "AWS broken" in the next few months

1. **First check** the symptoms table above and the 5 healthcheck commands.
2. If unhealthy and timestamps in `cache/*.json` are older than ~80 days → it's an expiry, re-seed.
3. If unhealthy but cache is fresh → something else broke. Look at `docker logs sso_server`, `journalctl -u claude-remote`, and the symptoms table. Don't re-seed blindly.
4. The headless Chrome path is allowed to be broken — don't waste time on it unless we're inventing a new architecture.
