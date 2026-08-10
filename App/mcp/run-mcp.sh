#!/bin/bash
# Cursor's MCP launcher often ignores mcp.json "cwd" and has no nvm PATH.
# Pin the working directory (needed for tsconfig path aliases) and Node binary.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
NODE="${PONA_FLOW_NODE:-/Users/mitchie/.nvm/versions/node/v20.20.1/bin/node}"
exec "$NODE" ./node_modules/tsx/dist/cli.mjs ./src/server.ts
