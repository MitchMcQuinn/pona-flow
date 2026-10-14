#!/bin/bash
# Cursor's MCP launcher often ignores mcp.json "cwd" and has no nvm PATH.
# Pin the working directory (needed for tsconfig path aliases) and Node binary.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
# Override with PONA_FLOW_NODE=/path/to/node when the launcher's PATH lacks Node (nvm etc.).
NODE="${PONA_FLOW_NODE:-$(command -v node || true)}"
if [ -z "$NODE" ]; then
  echo "run-mcp.sh: node not found on PATH; set PONA_FLOW_NODE=/path/to/node" >&2
  exit 1
fi
exec "$NODE" ./node_modules/tsx/dist/cli.mjs ./src/server.ts
