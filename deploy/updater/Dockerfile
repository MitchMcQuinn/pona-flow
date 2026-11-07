# Small sidecar so Settings → Update can pull and restart pona-flow.
# The Docker CLI talks to the host engine through the mounted socket.
FROM docker:28-cli

ARG COMPOSE_VERSION=v2.32.4

RUN apk add --no-cache curl ca-certificates \
 && arch="$(uname -m)" \
 && case "$arch" in \
      x86_64) carch=x86_64 ;; \
      aarch64|arm64) carch=aarch64 ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac \
 && mkdir -p /usr/local/lib/docker/cli-plugins \
 && curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${carch}" \
      -o /usr/local/lib/docker/cli-plugins/docker-compose \
 && chmod 755 /usr/local/lib/docker/cli-plugins/docker-compose \
 && docker compose version

COPY compose-updater.sh /usr/local/bin/compose-updater
RUN chmod 755 /usr/local/bin/compose-updater

ENTRYPOINT ["/usr/local/bin/compose-updater"]
