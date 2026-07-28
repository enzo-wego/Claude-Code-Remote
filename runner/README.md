# EnzoBot Mac Runner

The Mac side of the Entity's execution plane. Polls the VPS job queue outbound
every ~10s, runs each job as a **watchable Claude Code TUI in a herdr pane**
(workspace `enzobot`), and posts results back. Outbound-only: no ports opened
on the Mac, NAT-safe, and jobs simply wait while the lid is closed.

Job kinds: `review` (plain review), `apex_review` (runs the `/apex-review`
skill), `post_review` (publishes an approved review via your own `gh` auth).

## Requirements

- herdr server running (`herdr status server`)
- `claude` on PATH
- `gh` authenticated (`gh auth status`) — used only by `post_review`
- The repos you review, cloned locally

## Configure

Create `~/.enzobot-runner.json`:

```json
{
  "vpsUrl": "http://<vps-host>:9999",
  "token": "<RUNNER_TOKEN — same value as the VPS .env>",
  "repoRoot": "~/go/src/github.com",
  "repoMap": {
    "wego/payments": "~/go/src/github.com/payments",
    "wego/tax-service": "~/go/src/github.com/tax-service"
  },
  "pollMs": 10000,
  "cliCommand": "claude",
  "jobTimeoutMs": 1500000
}
```

`repoMap` is optional per repo — unmapped repos fall back to
`<repoRoot>/<repo-name>` if that directory exists. A job for a repo with no
local checkout fails with a clear error rather than guessing.

## Run

**Foreground (recommended while testing — you see every poll):**

```bash
node runner/enzobot-runner.js
```

Expected first line: `[runner] polling http://<vps-host>:9999 every 10000ms`

**Background via launchd (once you trust it):**

```bash
sed -e "s|__NODE__|$(which node)|" -e "s|__REPO__|$(pwd)|" \
  runner/com.enzo.enzobot-runner.plist > ~/Library/LaunchAgents/com.enzo.enzobot-runner.plist
launchctl load ~/Library/LaunchAgents/com.enzo.enzobot-runner.plist
tail -f /tmp/enzobot-runner.log
```

Uninstall: `launchctl unload ~/Library/LaunchAgents/com.enzo.enzobot-runner.plist`

## Verify the link without GitHub

Proves the VPS↔Mac channel and auth end-to-end:

```bash
TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.enzobot-runner.json')))['token'])")
URL=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.enzobot-runner.json')))['vpsUrl'])")

# correct token → {"job":null} when the queue is empty
curl -s -X POST "$URL/runner/lease" -H "content-type: application/json" \
  -H "x-runner-token: $TOKEN" -d '{"target":"mac"}'

# wrong token → 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL/runner/lease" \
  -H "content-type: application/json" -H "x-runner-token: nope" -d '{}'
```

## Watching work happen

Jobs run in the `enzobot` herdr workspace, one tab per job
(`review-412`, `apex-412`). Panes stay open after completion so you can read
the transcript. The runner only ever touches panes it created.

## Night-shift power note

Jobs targeted at the Mac only run while it's awake. Either keep it plugged in
and awake (`pmset` / Amphetamine), schedule a wake window
(`sudo pmset repeat wakeorpoweron MTWRFSU 02:00:00`), or accept that Mac jobs
drain when you next open the lid.

## Safety

- The runner never posts to GitHub on its own — `post_review` jobs are only
  enqueued when you tap **📤 Post** in Slack.
- `/apex-review` reviews in an isolated git worktree; your working tree is untouched.
- Auth is fail-closed: if `RUNNER_TOKEN` is unset on the VPS, every request is rejected.
