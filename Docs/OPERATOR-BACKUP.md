# Operator backup and restore

One instance, one client. If you cannot restore this, do not put their records on the host.

You are the host until someone else is. Rehearsal means: a **remote** machine (VPS, small VM), Clerk on, `PONA_FLOW_DISABLE_AUTH` **unset**, Cloudflare in front of `:8765` — not another folder on your laptop. Practice backup and restore **on that host** (or a second host) before a client depends on it.

What to copy, every time:

| Piece | What it is | Typical location |
| ----- | ---------- | ---------------- |
| Catalog SQLite | Spaces, members, saved queries, run `state`, credential *names* | `$SQLITE_DATABASE_PATH` (often `data.db` at the repo root) |
| Per-space SQLite | Nested entity payloads for that space | Env value of each space’s `sqlite_database_path_key` |
| Neo4j | SCHEMA / INSTANCE / STEP graph | Env value of each space’s `neo4j_uri_key` (often the instance default `NEO4J_URI`) |
| Secret store | Credential *values*, Neo4j passwords, Clerk | Host env / secret manager — **not** the SQLite files |

`space_credentials` stores metadata and env key names only. Restoring SQLite without restoring those env values means HTTP steps that use `$secret.NAME` will fail.

## 1. Inventory (run on the host)

Stop or pause writers if you can; then:

```bash
# Catalog path — same key the server uses
echo "$SQLITE_DATABASE_PATH"

sqlite3 "$SQLITE_DATABASE_PATH" \
  "SELECT id, name, sqlite_database_path_key, neo4j_uri_key FROM spaces;"
```

For each `sqlite_database_path_key` / `neo4j_uri_key`, resolve the env var (empty means the instance default: `SQLITE_DATABASE_PATH` / `NEO4J_URI`). Also copy `-wal` / `-shm` only if you `cp` a live file; prefer the SQLite backup command below so you do not have to.

## 2. Backup

Pick a dated directory, e.g. `/var/backups/pona-flow/$(date -u +%Y%m%dT%H%M%SZ)`.

**SQLite** (catalog and every distinct space path):

```bash
sqlite3 "$SQLITE_DATABASE_PATH" ".backup '$BACKUP_DIR/catalog.sqlite'"
sqlite3 "$SPACE_SQLITE_PATH"    ".backup '$BACKUP_DIR/space-<id>.sqlite'"
```

**Neo4j** (offline dump; stop the DBMS or use the vendor’s documented online backup). Community example:

```bash
neo4j-admin database dump neo4j --to-path="$BACKUP_DIR/neo4j"
```

If several spaces share one DBMS, one dump covers them. If a space has its own URI, dump that DBMS too. Aura / a managed graph: use that vendor’s export; do not skip it.

**Secrets:** copy the host’s env/secret list (or snapshot the secret manager). Do not commit it to git.

Keep the last restore you *tested*. Untested backups are not backups.

## 3. Restore (rehearse this once on purpose)

1. Stop uvicorn (and anything else writing the catalog or space DBs).
2. Restore Neo4j first (`neo4j-admin database load … --overwrite-destination=true`, or the vendor restore), then start Neo4j and confirm it accepts the URI.
3. Replace catalog and space SQLite files with the `.backup` copies (same paths the env keys point at).
4. Restore env/secrets so `$secret.NAME` and Neo4j passwords exist.
5. Start uvicorn. Sign in. Open the space. Run one sequence. Confirm a known record is present.

If that rehearsal fails, fix the procedure before a client’s data is on the box.

## 4. Cadence

Daily backup of catalog + space SQLite + Neo4j is enough for a first client; keep at least seven days. After a schema-heavy session, take an extra copy. Test restore when you first provision the host, not when the disk dies.

Operator checklist for the rest of the instance (Clerk, Cloudflare, outbound allowlist, first user = admin): [DEPLOYMENT.md](DEPLOYMENT.md) §8.
