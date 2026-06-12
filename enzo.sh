#!/bin/bash
# Claude Code Remote - Slack Socket Mode Agent
# Usage: ./enzo.sh [start|stop|restart|status|logs]
#
# Production runs as the `claude-remote.service` systemd unit. When that unit
# is active, start/stop/restart here would race systemd (Restart=always
# respawns whatever we kill, and a 2026-06-12 incident showed the default
# KillMode=control-group reaping the tmux server and every in-flight CLI
# session along with it). All lifecycle commands detect the unit and defer
# to systemctl instead of touching the process directly.

APP_NAME="enzo"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$APP_DIR/tmp/$APP_NAME.pid"
LOG_FILE="$APP_DIR/tmp/$APP_NAME.log"
SYSTEMD_UNIT="claude-remote.service"

mkdir -p "$APP_DIR/tmp"

systemd_managed() {
    systemctl is-active --quiet "$SYSTEMD_UNIT" 2>/dev/null
}

start() {
    if systemd_managed; then
        echo "$SYSTEMD_UNIT is already running under systemd — nothing to start."
        return 1
    fi
    if is_running; then
        echo "$APP_NAME is already running (PID $(cat "$PID_FILE"))"
        return 1
    fi

    echo "Starting $APP_NAME..."
    cd "$APP_DIR"
    nohup node start-slack-socket.js >> "$LOG_FILE" 2>&1 &
    local pid=$!
    echo $pid > "$PID_FILE"
    sleep 1

    if kill -0 $pid 2>/dev/null; then
        echo "$APP_NAME started (PID $pid)"
        echo "Logs: tail -f $LOG_FILE"
    else
        echo "Failed to start $APP_NAME. Check logs:"
        tail -20 "$LOG_FILE"
        rm -f "$PID_FILE"
        return 1
    fi
}

stop() {
    if systemd_managed; then
        echo "$APP_NAME runs as $SYSTEMD_UNIT — killing the PID would just make systemd respawn it."
        echo "Use: sudo systemctl stop $SYSTEMD_UNIT"
        echo "(For a FULL shutdown also run 'tmux kill-server' afterwards — with"
        echo " KillMode=process, tmux and CLI sessions intentionally survive the unit.)"
        return 1
    fi
    if ! is_running; then
        echo "$APP_NAME is not running"
        rm -f "$PID_FILE"
        return 0
    fi

    local pid=$(cat "$PID_FILE")
    echo "Stopping $APP_NAME (PID $pid)..."
    kill "$pid" 2>/dev/null

    # Wait up to 5 seconds for graceful shutdown
    for i in $(seq 1 5); do
        if ! kill -0 "$pid" 2>/dev/null; then
            echo "$APP_NAME stopped"
            rm -f "$PID_FILE"
            return 0
        fi
        sleep 1
    done

    # Force kill
    echo "Force killing $APP_NAME..."
    kill -9 "$pid" 2>/dev/null
    rm -f "$PID_FILE"
    echo "$APP_NAME stopped (forced)"
}

restart() {
    if systemd_managed; then
        local killmode
        killmode=$(systemctl show -p KillMode --value "$SYSTEMD_UNIT" 2>/dev/null)
        if [ "$killmode" != "process" ]; then
            echo "REFUSING to restart: $SYSTEMD_UNIT has KillMode=$killmode."
            echo "A restart would kill the tmux server and every in-flight CLI session"
            echo "in the unit's control group (incident 2026-06-12)."
            echo "Fix first:  sudo systemctl edit $SYSTEMD_UNIT   # add [Service] KillMode=process"
            echo "            sudo systemctl daemon-reload"
            echo "Then re-run: $0 restart"
            return 1
        fi
        local mainpid
        mainpid=$(systemctl show -p MainPID --value "$SYSTEMD_UNIT" 2>/dev/null)
        echo "Restarting via systemd (SIGTERM MainPID $mainpid; Restart=always respawns,"
        echo "KillMode=process preserves tmux + CLI sessions)..."
        kill "$mainpid" 2>/dev/null
        return 0
    fi
    stop
    sleep 1
    start
}

status() {
    if is_running; then
        local pid=$(cat "$PID_FILE")
        echo "$APP_NAME is running (PID $pid)"
        echo "Log file: $LOG_FILE"
        echo "Log size: $(du -h "$LOG_FILE" 2>/dev/null | cut -f1)"
        echo ""
        echo "Last 5 log lines:"
        tail -5 "$LOG_FILE" 2>/dev/null
    else
        echo "$APP_NAME is not running"
    fi
}

logs() {
    if [ ! -f "$LOG_FILE" ]; then
        echo "No log file found at $LOG_FILE"
        return 1
    fi
    tail -f "$LOG_FILE"
}

is_running() {
    if [ -f "$PID_FILE" ]; then
        local pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

case "${1:-start}" in
    start)   start ;;
    stop)    stop ;;
    restart) restart ;;
    status)  status ;;
    logs)    logs ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|logs}"
        exit 1
        ;;
esac
