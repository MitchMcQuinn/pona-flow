# syntax=docker/dockerfile:1.7
#
# pona flow — single-container image (FastAPI engine + built React UI).
#
#   docker build -t pona-flow .
#   docker run --rm -p 8765:8765 -v pona-data:/data \
#     -e NEO4J_URI=bolt://host.docker.internal:7687 -e NEO4J_USER=neo4j -e NEO4J_PASSWORD=... \
#     pona-flow
#
# Runtime state (catalog data.db, per-space SQLite files, the writable credential .env)
# lives in /data. Neo4j is external — see docker-compose.yml for a bundled one.

# ---------------------------------------------------------------------------
# Stage 1: build the React UI
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS ui

ENV CYPRESS_INSTALL_BINARY=0 \
    npm_config_update_notifier=false

WORKDIR /src/App

# The UI depends on sibling workspace packages via "file:" links, so they must be present
# before `npm ci`. Copy manifests first to keep the dependency layer cacheable.
COPY App/ui/package.json App/ui/package-lock.json ./ui/
COPY App/composer ./composer
COPY App/authoring ./authoring
COPY App/connector ./connector
COPY App/regex-validator ./regex-validator
RUN cd ui && npm ci --no-audit --no-fund

COPY App/ui ./ui
COPY App/assets ./assets
RUN cd ui && npm run build

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM python:3.13-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY Engine ./Engine
COPY App/assets ./App/assets
COPY --from=ui /src/App/ui/dist ./App/ui/dist

RUN useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin pona \
    && mkdir -p /data \
    && chown pona:pona /data

USER pona

# PONA_FLOW_DATA_DIR  — where data.db / per-space SQLite / credential .env are written.
# PONA_FLOW_HOST      — tells the startup guard the listener is not loopback-only, so
#                       PONA_FLOW_DISABLE_AUTH / DEV_DB_EDITOR_TOKEN are refused here.
# FORWARDED_ALLOW_IPS — trust X-Forwarded-* from the reverse proxy in front (Secure cookies).
ENV PONA_FLOW_DATA_DIR=/data \
    PONA_FLOW_HOST=0.0.0.0 \
    PONA_FLOW_PORT=8765 \
    PONA_FLOW_CREDENTIAL_BACKEND=local \
    FORWARDED_ALLOW_IPS=*

VOLUME ["/data"]
EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8765/healthz', timeout=4).status == 200 else 1)"

# Single worker on purpose: the event scheduler and MCP session manager are in-process.
CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8765", "--app-dir", "Engine", "--proxy-headers"]
