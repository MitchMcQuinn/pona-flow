"""
pona flow development server — internal package.

This package implements the FastAPI/ASGI server that backs the App HTML tools
(React dashboard, SQLite catalog editor). It wires browser UIs and authenticated API
clients to the catalog database, per-space SQLite, and Neo4j. TLS/CORS are handled by
Cloudflare in front of each instance (see Docs/DECISIONS.md).

Modules:
  config        — project paths, .env loading, SQLite helpers
  id_generator  — ID_<uuid> strings for new graph/catalog entities
  migrations    — deterministic, ordered catalog schema application at startup
  spaces        — spaces registry in the catalog DB and connection resolution
  graph     — Neo4j reads/writes and graph validation queries
  catalog   — catalog SQLite CRUD (data.db editor + regex/queries tables)
  packages  — execute composed QUERY/CRUD packages (Cypher + SQLite + catalog upsert)
  execution — sequence EXECUTION package composer + resumable executor
  auth      — Clerk JWT verification and space-membership authorization
  app       — FastAPI routes, JSON API, static App/ file serving
"""
