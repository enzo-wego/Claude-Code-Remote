#!/usr/bin/env bash
# Daily CLI updater for the Claude Code Remote bot.
# Bumps codex, gemini, and claude to their latest releases. Run from cron at 00:00 UTC.
#
# - Gemini self-updates on each launch (transcript: "Update successful! The new version will be used on your next run.").
# - Claude has an internal auto-updater plus an explicit `claude update` command.
# - Codex has no built-in auto-update path — npm bump is the only way.
# We run the explicit update for all three so an alert investigation never
# pays the slow first-run update cost mid-incident.
#
# Live tmux sessions keep the binary they loaded at process start; only NEW
# tmux launches pick up the new version. Cron runs at 00:00 UTC — a quiet
# window for PD alerts on the EU/SG morning shift.

set -uo pipefail

export PATH="/home/enzo/.local/bin:/home/enzo/.nvm/versions/node/v24.15.0/bin:$PATH"
export NPM_CONFIG_UPDATE_NOTIFIER=false

LOG_DIR="/var/go/src/github.com/Claude-Code-Remote/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/cli-updates.log"

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
say() { echo "[$(ts)] $*" | tee -a "$LOG"; }

update_one() {
    local label="$1"; shift
    local current_cmd="$1"; shift
    local before
    before=$(eval "$current_cmd" 2>/dev/null | head -1 || echo missing)
    say "$label: before=$before"
    if "$@" >>"$LOG" 2>&1; then
        local after
        after=$(eval "$current_cmd" 2>/dev/null | head -1 || echo missing)
        say "$label: after=$after"
    else
        say "$label: UPDATE FAILED (see log)"
    fi
}

say "=== update-clis run start ==="

update_one "codex"  "codex  --version" npm install -g @openai/codex@latest
update_one "gemini" "gemini --version" npm install -g @google/gemini-cli@latest
update_one "claude" "claude --version" claude update

say "=== update-clis run end ==="
