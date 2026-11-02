#!/bin/sh
# One VM: Neo4j Community on localhost, then the pona flow process.
# Catalog SQLite and Neo4j data both live under PONA_FLOW_DATA_DIR (the Fly volume).
set -eu

NEO4J_HOME=/opt/neo4j
DATA_ROOT="${PONA_FLOW_DATA_DIR:-/data}"
NEO4J_DATA="$DATA_ROOT/neo4j"

if [ -z "${NEO4J_PASSWORD:-}" ]; then
  echo "NEO4J_PASSWORD is required" >&2
  exit 1
fi

mkdir -p "$NEO4J_DATA/data" "$NEO4J_DATA/logs" "$NEO4J_DATA/transactions" "$DATA_ROOT"

cat > "$NEO4J_HOME/conf/neo4j.conf" <<EOF
server.default_listen_address=127.0.0.1
server.bolt.listen_address=127.0.0.1:7687
server.bolt.advertised_address=127.0.0.1:7687
server.bolt.tls_level=DISABLED
server.http.listen_address=127.0.0.1:7474
server.http.enabled=true
server.memory.heap.initial_size=512m
server.memory.heap.max_size=512m
server.memory.pagecache.size=256m
server.directories.data=$NEO4J_DATA/data
server.directories.logs=$NEO4J_DATA/logs
server.directories.transaction.logs.root=$NEO4J_DATA/transactions
EOF

if [ ! -f "$NEO4J_DATA/.password-initialized" ]; then
  "$NEO4J_HOME/bin/neo4j-admin" dbms set-initial-password "$NEO4J_PASSWORD"
  touch "$NEO4J_DATA/.password-initialized"
fi

"$NEO4J_HOME/bin/neo4j" start

python - <<'PY'
import socket
import sys
import time

for _ in range(90):
    try:
        sock = socket.create_connection(("127.0.0.1", 7687), 2)
    except OSError:
        time.sleep(2)
        continue
    sock.close()
    sys.exit(0)
sys.exit("Neo4j bolt did not open on 127.0.0.1:7687")
PY

export NEO4J_URI="${NEO4J_URI:-bolt://127.0.0.1:7687}"
export NEO4J_USER="${NEO4J_USER:-neo4j}"

uvicorn server.app:app --host 0.0.0.0 --port "${PONA_FLOW_PORT:-8765}" --app-dir Engine --proxy-headers &
child=$!
trap 'kill -TERM "$child" 2>/dev/null || true; "$NEO4J_HOME/bin/neo4j" stop || true; wait "$child" || true' TERM INT
wait "$child"
