#!/bin/sh
# Watches the shared data volume for an admin's update request, then pulls and
# recreates the pona-flow service. The request file's contents are ignored so the
# app cannot pass a shell command through it.
#
# Compose has to run with the project directory mounted at the same path the host
# used. Otherwise the daemon would receive this container's paths as bind mounts.
set -u

request=/data/update-request
result=/data/update-result
watcher=/data/update-watcher

write_ok() {
  printf 'ok\n' > "$result"
  chmod 666 "$result" 2>/dev/null || true
}

write_fail() {
  printf 'fail\n%s\n' "$1" > "$result"
  chmod 666 "$result" 2>/dev/null || true
}

heartbeat() {
  while true; do
    date +%s > "$watcher" 2>/dev/null || true
    chmod 666 "$watcher" 2>/dev/null || true
    sleep 2
  done
}

discover() {
  self=$(hostname 2>/dev/null || cat /etc/hostname)
  working_dir=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$self" 2>/dev/null || true)
  project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$self" 2>/dev/null || true)
  self_image=$(docker inspect -f '{{.Config.Image}}' "$self" 2>/dev/null || true)
}

heartbeat &

echo "local updater: waiting for an update request"
while true; do
  if [ -f "$request" ]; then
    rm -f "$request"
    discover
    echo "local updater: project=${project:-?} dir=${working_dir:-?}"
    if [ -z "$working_dir" ] || [ -z "$project" ] || [ -z "$self_image" ]; then
      write_fail "could not see this compose project through the Docker socket"
      echo "local updater: docker inspect failed" >&2
    elif docker run --rm \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v "$working_dir:$working_dir" \
      -w "$working_dir" \
      -e "COMPOSE_PROJECT_NAME=$project" \
      --entrypoint sh \
      "$self_image" \
      -c 'docker compose pull pona-flow && docker compose up -d --no-deps pona-flow'
    then
      write_ok
      echo "local updater: restarted pona-flow"
    else
      write_fail "docker compose could not pull or restart pona-flow"
      echo "local updater: docker compose failed" >&2
    fi
  fi
  sleep 2
done
