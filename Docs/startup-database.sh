#!/usr/bin/env bash
set -euo pipefail

DBMS_DIR="/Users/mitchie/Library/Application Support/neo4j-desktop/Application/Data/dbmss/dbms-003132c1-44af-413e-b9fd-c102badc785e"
NEO4J_BIN="$DBMS_DIR/bin/neo4j"

if [[ ! -x "$NEO4J_BIN" ]]; then
    echo "Error: Neo4j binary missing or lacks executable permission at: $NEO4J_BIN" >&2
    exit 1
fi

echo "Igniting Neo4j instance..."
"$NEO4J_BIN" start

echo "Checking status..."
"$NEO4J_BIN" status