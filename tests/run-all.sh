#!/usr/bin/env bash
# Unified test runner: executes every tests/*.py via the project venv python
# and every tests/*.mjs via tsx (from App/ui/node_modules), reporting
# pass/fail counts. Usage:
#   tests/run-all.sh            # run everything
#   tests/run-all.sh composer   # run only files whose name matches "composer"
#
# Tests that need external services (Docker, Neo4j, a live dev server) can be
# skipped with SKIP_EXTERNAL=1 (skips the names listed in EXTERNAL_TESTS).

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="$ROOT/.venv/bin/python"
TSX="$ROOT/App/ui/node_modules/.bin/tsx"
FILTER="${1:-}"

# Tests that talk to Docker, Neo4j, or a running dev server.
EXTERNAL_TESTS=(
  diag-affected-ids.py
  diag-instance-currency.py
  diag-delete-pillar.py
  diag-delete-pillar-run.py
  connector-api-path.mjs
  step-flow-query-filter.mjs
)

is_external() {
  local name="$1"
  for ext in "${EXTERNAL_TESTS[@]}"; do
    [ "$name" = "$ext" ] && return 0
  done
  return 1
}

pass=0
fail=0
skip=0
failed_tests=()

run_one() {
  local file="$1"
  shift
  local name
  name="$(basename "$file")"
  if [ -n "$FILTER" ] && [[ "$name" != *"$FILTER"* ]]; then
    return
  fi
  if [ "${SKIP_EXTERNAL:-0}" = "1" ] && is_external "$name"; then
    echo "SKIP  $name"
    skip=$((skip + 1))
    return
  fi
  local out
  if out="$("$@" "$file" 2>&1)"; then
    echo "PASS  $name"
    pass=$((pass + 1))
  else
    echo "FAIL  $name"
    echo "$out" | sed 's/^/      /'
    fail=$((fail + 1))
    failed_tests+=("$name")
  fi
}

for f in "$ROOT"/tests/*.py; do
  run_one "$f" "$PYTHON"
done

# tsx resolves the @pona-flow/* workspace packages via App/ui/tsconfig.json "paths", which
# it only reads when App/ui is the working directory.
cd "$ROOT/App/ui"
for f in "$ROOT"/tests/*.mjs; do
  run_one "$f" "$TSX"
done
cd "$ROOT"

echo
echo "== ${pass} passed, ${fail} failed, ${skip} skipped =="
if [ "$fail" -gt 0 ]; then
  printf 'failed: %s\n' "${failed_tests[@]}"
  exit 1
fi
