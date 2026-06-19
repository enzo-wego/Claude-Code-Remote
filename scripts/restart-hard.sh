#!/usr/bin/env bash
#
# Hard restart: stop the bot, kill the tmux server (ALL CLI sessions incl.
# _keepalive), then start the bot fresh.
#
# Why this exists: the systemd unit runs with KillMode=process, so a normal
# `systemctl restart claude-remote` deliberately KEEPS the tmux server and every
# live CLI session alive across the restart (safe deploys). That means a normal
# restart no longer clears stuck/busy-looping sessions, nor refreshes sessions
# that baked stale launch-time env (CLI_SOURCE, the Gemini HTTPS_PROXY tunnel,
# MCP vars, node/PATH). Use this hard restart only when you actually want the
# old "nuke everything" behaviour.
#
# Usage:
#   npm run restart:hard          # prompts for confirmation
#   npm run restart:hard -- -y    # skip the prompt (automation)
#
set -euo pipefail

SERVICE="claude-remote"
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Use sudo only if not already root.
SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

echo "=== current state ==="
$SUDO systemctl is-active "$SERVICE" || true
echo "tmux sessions:"
tmux ls 2>/dev/null || echo "  (no tmux server running)"
echo

if [ "$ASSUME_YES" -ne 1 ]; then
  printf "This will KILL all tmux/CLI sessions above and restart %s. Continue? [y/N] " "$SERVICE"
  read -r reply
  case "$reply" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

echo "=== stopping $SERVICE ==="
$SUDO systemctl stop "$SERVICE"

echo "=== killing tmux server ==="
tmux kill-server 2>/dev/null && echo "tmux server killed" || echo "no tmux server to kill"

echo "=== starting $SERVICE ==="
$SUDO systemctl start "$SERVICE"

# Give it a moment to boot + connect Socket Mode.
sleep 6

echo "=== post-restart health ==="
STATE=$($SUDO systemctl is-active "$SERVICE" || true)
echo "service: $STATE"
$SUDO journalctl -u "$SERVICE" --since '20 seconds ago' --no-pager 2>/dev/null \
  | grep -iE 'reconciliation|Socket Mode is running|Socket Mode connected' | tail -5 \
  || echo "(no startup log lines matched — check 'journalctl -u $SERVICE' manually)"

[ "$STATE" = "active" ] || { echo "WARNING: service is not active after restart"; exit 1; }
echo "OK — hard restart complete."
