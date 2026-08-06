"""
Agent API keys — minting, verification, and lifecycle for non-Clerk principals.

Purpose in the project
----------------------
Clerk authenticates humans; agents (AI tools calling sequence webhooks, and the future
per-space MCP server) authenticate with a per-space API key instead (see Docs/DECISIONS.md).

Each key:
  - belongs to one space and one agent principal (a ``users`` row with
    ``principal_type = 'agent'``) that has a ``space_members`` row — so the existing RBAC
    sequence-run allowlist decides which sequences the key may run;
  - is a random ``stg_<token>`` string shown once at mint time and stored only as a
    SHA-256 hash (constant-time compared on verify).

This module knows nothing about FastAPI; ``auth.py`` wraps ``verify_key`` in a request
dependency and ``app.py`` exposes the management routes.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import sqlite3
from typing import Any

from . import config, id_generator, rbac

# Plaintext tokens are prefixed so they are recognizable in headers/logs and so the
# dual-auth dependency can cheaply distinguish them from a Clerk JWT.
KEY_PREFIX = "stg_"


def _conn() -> sqlite3.Connection:
    return config.connect_sqlite(config.catalog_sqlite_path())


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def mint_key(space_id: str, name: str, role_id: str | None = None) -> dict[str, Any]:
    """
    Create a new agent principal + space membership and issue an API key for it.

    Returns the key metadata plus the plaintext ``token`` (shown ONCE; only its hash is
    stored). The agent's membership role (``role_id``, default Member) governs which
    sequences the key can run.
    """
    sid = (space_id or "").strip()
    nm = (name or "").strip()
    if not sid or not nm:
        raise ValueError("space_id and name are required")

    # Resolve and validate the membership role BEFORE writing any rows so a bad
    # (e.g. foreign-space) role id cannot leave behind an orphaned principal/key.
    rid = (role_id or "").strip() or None
    if rid is None:
        roles = rbac.seed_default_roles(sid)
        rid = roles.get(rbac.MEMBER_ROLE_NAME)

    token = KEY_PREFIX + secrets.token_urlsafe(32)
    key_hash = _hash_token(token)
    key_id = id_generator.generate_id()
    principal_id = id_generator.generate_id()

    # Agent principals have no Clerk identity. The schema allows a NULL clerk_user_id,
    # but databases created before that change still carry a NOT NULL constraint, so we
    # store a synthetic, unique, non-Clerk id (never a real JWT ``sub``) to satisfy both.
    synthetic_clerk_id = f"agent:{principal_id}"

    conn = _conn()
    try:
        rbac._require_role_in_space(conn, rid, sid)
        conn.execute(
            "INSERT INTO users (id, clerk_user_id, email, display_name, principal_type) "
            "VALUES (?, ?, NULL, ?, 'agent')",
            (principal_id, synthetic_clerk_id, nm),
        )
        conn.execute(
            "INSERT INTO agent_keys (id, space_id, principal_id, name, key_hash) "
            "VALUES (?, ?, ?, ?, ?)",
            (key_id, sid, principal_id, nm, key_hash),
        )
        conn.commit()
    finally:
        conn.close()

    # Grant the agent principal space membership so RBAC sequence-run checks resolve.
    rbac.add_member(sid, principal_id, is_owner=False, role_id=rid)

    return {
        "id": key_id,
        "space_id": sid,
        "principal_id": principal_id,
        "name": nm,
        "token": token,
        "role_id": rid,
    }


def verify_key(token: str) -> dict[str, Any] | None:
    """
    Resolve a plaintext agent token to its key/principal/space, or ``None`` if the token
    is unknown, malformed, or revoked. Hash comparison is constant-time. Records
    ``last_used_date`` on success.
    """
    tok = (token or "").strip()
    if not tok or not tok.startswith(KEY_PREFIX):
        return None
    key_hash = _hash_token(tok)
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT id, space_id, principal_id, name, key_hash, revoked "
            "FROM agent_keys WHERE key_hash = ?",
            (key_hash,),
        ).fetchone()
        if row is None or int(row["revoked"] or 0):
            return None
        # Defense-in-depth: constant-time compare even though we matched on the hash.
        if not hmac.compare_digest(str(row["key_hash"]), key_hash):
            return None
        conn.execute(
            "UPDATE agent_keys SET last_used_date = datetime('now') WHERE id = ?",
            (row["id"],),
        )
        conn.commit()
        return {
            "key_id": row["id"],
            "space_id": row["space_id"],
            "principal_id": row["principal_id"],
            "name": row["name"],
        }
    finally:
        conn.close()


def list_keys(space_id: str) -> list[dict[str, Any]]:
    """List a space's agent keys (metadata only; never the token or its hash)."""
    sid = (space_id or "").strip()
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT id, space_id, principal_id, name, last_used_date, revoked, creation_date "
            "FROM agent_keys WHERE space_id = ? ORDER BY creation_date DESC",
            (sid,),
        ).fetchall()
        return [
            {
                "id": r["id"],
                "space_id": r["space_id"],
                "principal_id": r["principal_id"],
                "name": r["name"],
                "last_used_date": r["last_used_date"],
                "revoked": bool(r["revoked"]),
                "creation_date": r["creation_date"],
            }
            for r in rows
        ]
    finally:
        conn.close()


def revoke_key(space_id: str, key_id: str) -> dict[str, Any]:
    """
    Revoke a key (idempotent). The key can no longer authenticate; the agent principal
    and its audit history are left intact.
    """
    sid = (space_id or "").strip()
    kid = (key_id or "").strip()
    if not sid or not kid:
        raise ValueError("space_id and key_id are required")
    conn = _conn()
    try:
        conn.execute(
            "UPDATE agent_keys SET revoked = 1 WHERE id = ? AND space_id = ?",
            (kid, sid),
        )
        conn.commit()
        return {"id": kid, "revoked": True}
    finally:
        conn.close()
