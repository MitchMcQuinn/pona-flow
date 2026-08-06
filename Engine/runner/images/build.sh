#!/usr/bin/env bash
# Build the sandbox images used by the code-execution runner.
#
#   Engine/runner/images/build.sh
#
# Override the tags with PONA_FLOW_RUNNER_IMAGE_PYTHON / PONA_FLOW_RUNNER_IMAGE_NODE
# (the runner reads the same variables at execution time).

set -euo pipefail

cd "$(dirname "$0")"

PYTHON_TAG="${PONA_FLOW_RUNNER_IMAGE_PYTHON:-pona-flow-runner-python:latest}"
NODE_TAG="${PONA_FLOW_RUNNER_IMAGE_NODE:-pona-flow-runner-node:latest}"

echo "Building ${PYTHON_TAG} ..."
docker build -t "${PYTHON_TAG}" python/

echo "Building ${NODE_TAG} ..."
docker build -t "${NODE_TAG}" node/

echo "Done. Images:"
docker image ls "${PYTHON_TAG%%:*}" "${NODE_TAG%%:*}"
