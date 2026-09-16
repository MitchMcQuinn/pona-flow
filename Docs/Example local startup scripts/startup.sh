#!/bin/bash
# Login / Cursor startup: Pona engine + UIs + llm-server without port collisions.
#   8765  Pona Flow Python API
#   5174  Pona Flow workspace UI
#   5173  Local Chat (Tailscale Serve :8443)
#   8000  llm-server (local Ollama config API + UI)
#
# Before starting, any process still listening on those ports is stopped so a
# re-run refreshes cleanly instead of skipping with "already running".
#
# Login runs the copy at:
#   ~/Library/Application Support/dev-servers/startup.sh
# macOS blocks LaunchAgents from executing scripts inside ~/Documents.
# After editing this file (or the sibling under pona-flow-engine/):
#   cp Docs/startup.sh ~/Library/Application\ Support/dev-servers/startup.sh
#   # or: cp ../startup.sh ~/Library/Application\ Support/dev-servers/startup.sh

export HOME="${HOME:-/Users/mitchie}"
cd "$HOME" || exit 1

PONAPATH="/Users/mitchie/Documents/pona-flow/pona-flow-engine/pona-flow"
CHATPATH="/Users/mitchie/Documents/Local Chat/local-chat"
LLMPATH="/Users/mitchie/Documents/LLM Server/llm-server"
NODE_BIN="/Users/mitchie/.nvm/versions/node/v20.20.1/bin"
PYTHON_BIN="$PONAPATH/.venv/bin/python"
LLM_PYTHON_BIN="$LLMPATH/.venv/bin/python"

export PATH="$NODE_BIN:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export VIRTUAL_ENV="$PONAPATH/.venv"

echo "===== $(date) pid=$$ ====="

listening() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# Stop whatever is still bound to a managed port (SIGTERM, then SIGKILL if needed).
stop_port() {
  local port="$1"
  local pids
  pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u | tr '\n' ' ')"
  pids="${pids%% }"
  if [ -z "$pids" ]; then
    return 0
  fi
  echo "Stopping listeners on :$port (pids: $pids)..."
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    listening "$port" || return 0
    sleep 0.4
  done
  pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u | tr '\n' ' ')"
  pids="${pids%% }"
  if [ -n "$pids" ]; then
    echo "Force-killing listeners on :$port (pids: $pids)..."
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
    sleep 0.3
  fi
}

# Keep the child in this shell's job table (so `wait` works) and give it a
# real cwd. Do not background *inside* a subshell — that is what produced
# npm's `uv_cwd` EPERM after Automator/the subshell exited.
start() {
  local name="$1" port="$2" cwd="$3" log="$4"
  shift 4

  if listening "$port"; then
    echo "ERROR: $name port :$port is still in use after stop; skipping"
    return 1
  fi
  if [ ! -d "$cwd" ]; then
    echo "ERROR: $name directory missing: $cwd" | tee "$log"
    return 1
  fi

  echo "Starting $name on :$port ..."
  : >"$log"
  cd "$cwd" || return 1
  nohup "$@" >>"$log" 2>&1 &
  echo "$name pid $!"
  cd "$HOME" || return 1
}

echo "Refreshing managed ports..."
stop_port 8765
stop_port 5174
stop_port 5173
stop_port 8000

start "Python API" 8765 "$PONAPATH" "$HOME/python_debug.log" \
  "$PYTHON_BIN" Engine/dev_server.py

start "Pona Flow UI" 5174 "$PONAPATH/App/ui" "$HOME/pona_vite.log" \
  "$NODE_BIN/npm" run dev -- --host 127.0.0.1 --port 5174 --strictPort

start "Local Chat" 5173 "$CHATPATH" "$HOME/local_chat_vite.log" \
  "$NODE_BIN/npm" run dev -- --host 127.0.0.1 --port 5173 --strictPort

start "llm-server" 8000 "$LLMPATH" "$HOME/llm_server.log" \
  "$LLM_PYTHON_BIN" -m app

# Stay alive so launchd does not tear down the process group.
wait
