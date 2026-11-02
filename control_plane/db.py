"""SQLite for accounts, instances, and one-time VIP codes.

Self-hosted Fly tokens and Aura passwords are not columns.
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .lifecycle import sandbox_blocks_another
from .util import iso, new_id, utcnow

INSTANCE_FIELDS = (
    "tier",
    "status",
    "app_name",
    "region",
    "public_url",
    "fly_machine_id",
    "volume_id",
    "stripe_customer_id",
    "stripe_subscription_id",
    "subscription_status",
    "fleet_token_hash",
    "neo4j_password_enc",
    "secrets_configured",
    "admin_ready",
    "event_count",
    "sleep_allowed",
    "expires_at",
    "suspended_at",
    "delete_after",
    "error",
)


class Database:
    def __init__(self, path: str | Path):
        self.path = str(path)
        self._init()

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init(self) -> None:
        with self._conn() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS accounts (
                  id TEXT PRIMARY KEY,
                  email TEXT UNIQUE NOT NULL,
                  password_hash TEXT NOT NULL,
                  display_name TEXT,
                  email_verified INTEGER NOT NULL DEFAULT 0,
                  created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                  token_hash TEXT PRIMARY KEY,
                  account_id TEXT NOT NULL,
                  created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS verify_tokens (
                  token_hash TEXT PRIMARY KEY,
                  account_id TEXT NOT NULL,
                  expires_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS instances (
                  id TEXT PRIMARY KEY,
                  account_id TEXT NOT NULL,
                  tier TEXT NOT NULL,
                  status TEXT NOT NULL,
                  app_name TEXT,
                  region TEXT,
                  public_url TEXT,
                  fly_machine_id TEXT,
                  volume_id TEXT,
                  stripe_customer_id TEXT,
                  stripe_subscription_id TEXT,
                  subscription_status TEXT,
                  fleet_token_hash TEXT,
                  neo4j_password_enc TEXT,
                  secrets_configured INTEGER NOT NULL DEFAULT 0,
                  admin_ready INTEGER NOT NULL DEFAULT 0,
                  event_count INTEGER NOT NULL DEFAULT 0,
                  sleep_allowed INTEGER NOT NULL DEFAULT 0,
                  expires_at TEXT,
                  suspended_at TEXT,
                  delete_after TEXT,
                  error TEXT,
                  created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS vip_codes (
                  code_hash TEXT PRIMARY KEY,
                  redeemed_by TEXT,
                  redeemed_at TEXT,
                  created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS stripe_events (
                  id TEXT PRIMARY KEY,
                  received_at TEXT NOT NULL
                );
                """
            )

    def create_account(self, email: str, password_hash: str, display_name: str | None) -> dict[str, Any]:
        account_id = new_id()
        now = iso(utcnow())
        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO accounts (id, email, password_hash, display_name, email_verified, created_at)
                VALUES (?, ?, ?, ?, 0, ?)
                """,
                (account_id, email, password_hash, (display_name or "").strip() or None, now),
            )
        row = self.account_by_id(account_id)
        if row is None:
            raise RuntimeError("account insert failed")
        return row

    def account_by_email(self, email: str) -> dict[str, Any] | None:
        with self._conn() as conn:
            row = conn.execute("SELECT * FROM accounts WHERE email = ?", (email,)).fetchone()
        return dict(row) if row else None

    def account_by_id(self, account_id: str) -> dict[str, Any] | None:
        with self._conn() as conn:
            row = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
        return dict(row) if row else None

    def mark_verified(self, account_id: str) -> None:
        with self._conn() as conn:
            conn.execute("UPDATE accounts SET email_verified = 1 WHERE id = ?", (account_id,))

    def save_verify_token(self, token_hash: str, account_id: str, expires_at: str) -> None:
        with self._conn() as conn:
            conn.execute("DELETE FROM verify_tokens WHERE account_id = ?", (account_id,))
            conn.execute(
                "INSERT INTO verify_tokens (token_hash, account_id, expires_at) VALUES (?, ?, ?)",
                (token_hash, account_id, expires_at),
            )

    def take_verify_token(self, token_hash: str, now_iso: str) -> str | None:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT account_id, expires_at FROM verify_tokens WHERE token_hash = ?",
                (token_hash,),
            ).fetchone()
            if row is None or str(row["expires_at"]) < now_iso:
                return None
            conn.execute("DELETE FROM verify_tokens WHERE token_hash = ?", (token_hash,))
            return str(row["account_id"])

    def create_session(self, token_hash: str, account_id: str) -> None:
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO sessions (token_hash, account_id, created_at) VALUES (?, ?, ?)",
                (token_hash, account_id, iso(utcnow())),
            )

    def account_for_session(self, token_hash: str) -> dict[str, Any] | None:
        with self._conn() as conn:
            row = conn.execute(
                """
                SELECT accounts.* FROM accounts
                JOIN sessions ON sessions.account_id = accounts.id
                WHERE sessions.token_hash = ?
                """,
                (token_hash,),
            ).fetchone()
        return dict(row) if row else None

    def delete_session(self, token_hash: str) -> None:
        with self._conn() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))

    def insert_instance(self, account_id: str, **fields: Any) -> dict[str, Any]:
        instance_id = str(fields.pop("id", "") or new_id())
        unknown = set(fields) - set(INSTANCE_FIELDS)
        if unknown:
            raise ValueError("unsupported instance fields: " + ", ".join(sorted(unknown)))
        columns = ["id", "account_id", "created_at", *fields.keys()]
        values: list[Any] = [instance_id, account_id, iso(utcnow()), *fields.values()]
        placeholders = ", ".join("?" for _ in columns)
        with self._conn() as conn:
            conn.execute(
                f"INSERT INTO instances ({', '.join(columns)}) VALUES ({placeholders})",
                values,
            )
        row = self.instance(instance_id)
        if row is None:
            raise RuntimeError("instance insert failed")
        return row

    def update_instance(self, instance_id: str, **fields: Any) -> dict[str, Any]:
        unknown = set(fields) - set(INSTANCE_FIELDS)
        if unknown:
            raise ValueError("unsupported instance fields: " + ", ".join(sorted(unknown)))
        if not fields:
            row = self.instance(instance_id)
            if row is None:
                raise KeyError(instance_id)
            return row
        assignments = ", ".join(f"{name} = ?" for name in fields)
        with self._conn() as conn:
            conn.execute(
                f"UPDATE instances SET {assignments} WHERE id = ?",
                (*fields.values(), instance_id),
            )
        row = self.instance(instance_id)
        if row is None:
            raise KeyError(instance_id)
        return row

    def instance(self, instance_id: str) -> dict[str, Any] | None:
        with self._conn() as conn:
            row = conn.execute("SELECT * FROM instances WHERE id = ?", (instance_id,)).fetchone()
        return dict(row) if row else None

    def instances_for_account(self, account_id: str) -> list[dict[str, Any]]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM instances WHERE account_id = ? ORDER BY created_at",
                (account_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def has_active_sandbox(self, account_id: str) -> bool:
        for row in self.instances_for_account(account_id):
            if sandbox_blocks_another(row):
                return True
        return False

    def count_active_sandboxes(self) -> int:
        with self._conn() as conn:
            rows = conn.execute("SELECT tier, status FROM instances").fetchall()
        return sum(1 for row in rows if sandbox_blocks_another(dict(row)))

    def running_sandboxes(self) -> list[dict[str, Any]]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM instances WHERE tier = 'sandbox' AND status = 'running'"
            ).fetchall()
        return [dict(row) for row in rows]

    def suspended_instances(self) -> list[dict[str, Any]]:
        with self._conn() as conn:
            rows = conn.execute("SELECT * FROM instances WHERE status = 'suspended'").fetchall()
        return [dict(row) for row in rows]

    def insert_vip(self, code_hash: str) -> None:
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO vip_codes (code_hash, created_at) VALUES (?, ?)",
                (code_hash, iso(utcnow())),
            )

    def redeem_vip(self, code_hash: str, account_id: str, now_iso: str) -> bool:
        with self._conn() as conn:
            cur = conn.execute(
                """
                UPDATE vip_codes
                SET redeemed_by = ?, redeemed_at = ?
                WHERE code_hash = ? AND redeemed_by IS NULL
                """,
                (account_id, now_iso, code_hash),
            )
            return cur.rowcount == 1

    def remember_stripe_event(self, event_id: str) -> bool:
        """Return True the first time this event is seen."""
        with self._conn() as conn:
            try:
                conn.execute(
                    "INSERT INTO stripe_events (id, received_at) VALUES (?, ?)",
                    (event_id, iso(utcnow())),
                )
            except sqlite3.IntegrityError:
                return False
        return True
