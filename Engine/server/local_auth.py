"""
Built-in authentication: email + password credentials and server-issued sessions.

Purpose in the project
----------------------
Self-hosted instances should not need a third-party identity provider to sign in. This
module is the storage and crypto layer for that path (``PONA_FLOW_AUTH_MODE=local``, the
default). It knows nothing about FastAPI; ``auth.py`` turns a session cookie into a
``Principal`` and ``routes/auth.py`` exposes setup / login / logout / signup.

What lives here
---------------
- **Mode selection**: ``auth_mode()`` -> ``"local"`` | ``"clerk"``.
- **Passwords**: salted scrypt via the standard library (no extra dependency), stored in
  a self-describing ``scrypt$n$r$p$salt$hash`` string so parameters can be raised later
  without a migration.
- **Users**: the first local account is created through *setup* (only while no local
  credentials exist) and becomes the instance admin. Later accounts arrive through
  *signup*, which is allowed when the email has a pending space invite or when
  ``PONA_FLOW_ALLOW_OPEN_SIGNUP=1``.
- **Sessions**: random ``pfs_`` tokens, persisted as SHA-256 hashes with an expiry.
- **Login throttling**: a small in-memory sliding window keyed by client IP and by email,
  because a self-hosted instance may have no edge rate limiter in front of it.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from . import config, id_generator

# ---------------------------------------------------------------------------
# Mode
# ---------------------------------------------------------------------------

MODE_LOCAL = "local"
MODE_CLERK = "clerk"


def auth_mode() -> str:
    """``PONA_FLOW_AUTH_MODE``: ``local`` (default) or ``clerk``. Read fresh each call."""
    raw = (os.environ.get("PONA_FLOW_AUTH_MODE") or "").strip().lower()
    return MODE_CLERK if raw == MODE_CLERK else MODE_LOCAL


def open_signup_enabled() -> bool:
    raw = (os.environ.get("PONA_FLOW_ALLOW_OPEN_SIGNUP") or "").strip().lower()
    return raw in ("1", "true", "yes", "on")


def signup_can_create_spaces() -> bool:
    """Whether open/invite sign-up grants ``can_create_spaces`` (demo instances set this)."""
    raw = (os.environ.get("PONA_FLOW_SIGNUP_CAN_CREATE_SPACES") or "").strip().lower()
    return raw in ("1", "true", "yes", "on")


def session_lifetime() -> timedelta:
    raw = (os.environ.get("PONA_FLOW_SESSION_DAYS") or "30").strip()
    try:
        days = max(1, int(raw))
    except ValueError:
        days = 30
    return timedelta(days=days)


# ---------------------------------------------------------------------------
# Passwords (scrypt, stdlib)
# ---------------------------------------------------------------------------

# OWASP-recommended scrypt parameters: N=2^15, r=8, p=3 (32 MiB working set, ~100 ms).
_SCRYPT_N = 2**15
_SCRYPT_R = 8
_SCRYPT_P = 3
_SCRYPT_DKLEN = 32
# hashlib's default maxmem (32 MiB) is exactly the working set, so raise the ceiling.
_SCRYPT_MAXMEM = 128 * 1024 * 1024
MIN_PASSWORD_LENGTH = 10
MAX_PASSWORD_LENGTH = 256


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def validate_password(password: str) -> None:
    """Raise ``ValueError`` with a user-facing message when the password is unacceptable."""
    pw = password or ""
    if len(pw) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters.")
    if len(pw) > MAX_PASSWORD_LENGTH:
        raise ValueError(f"Password must be at most {MAX_PASSWORD_LENGTH} characters.")


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=_SCRYPT_DKLEN,
        maxmem=_SCRYPT_MAXMEM,
    )
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    """Constant-time check of ``password`` against a ``hash_password`` string."""
    try:
        algo, n, r, p, salt_b64, hash_b64 = (stored or "").split("$")
        if algo != "scrypt":
            return False
        expected = _unb64(hash_b64)
        actual = hashlib.scrypt(
            (password or "").encode("utf-8"),
            salt=_unb64(salt_b64),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(expected),
            maxmem=_SCRYPT_MAXMEM,
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


# ---------------------------------------------------------------------------
# Catalog access
# ---------------------------------------------------------------------------


def _conn() -> sqlite3.Connection:
    return config.connect_sqlite(config.catalog_sqlite_path())


def _schema_path(name: str):
    return config.ROOT / "Engine" / "schema" / name


def ensure_schema(conn: sqlite3.Connection) -> None:
    """Create the local auth tables (idempotent). Called by startup migrations."""
    for name in ("local-credentials-table.sql", "sessions-table.sql"):
        path = _schema_path(name)
        if path.is_file():
            conn.executescript(path.read_text(encoding="utf-8"))
    conn.commit()


def normalize_email(email: str) -> str:
    em = (email or "").strip().lower()
    if not em or "@" not in em or em.startswith("@") or em.endswith("@") or " " in em:
        raise ValueError("A valid email address is required.")
    if len(em) > 254:
        raise ValueError("Email address is too long.")
    return em


def setup_required() -> bool:
    """True until the first local account exists (drives the first-run setup page)."""
    conn = _conn()
    try:
        row = conn.execute("SELECT COUNT(*) AS n FROM local_credentials").fetchone()
        return int(row["n"] or 0) == 0
    except sqlite3.OperationalError:
        # Table not created yet (pre-migration call): setup is certainly required.
        return True
    finally:
        conn.close()


def has_pending_invite(email: str) -> bool:
    """Whether any space has a pending invite addressed to ``email``."""
    em = (email or "").strip()
    if not em:
        return False
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT 1 FROM space_members "
            "WHERE status = 'pending' AND lower(invited_email) = lower(?) LIMIT 1",
            (em,),
        ).fetchone()
        return row is not None
    except sqlite3.OperationalError:
        return False
    finally:
        conn.close()


def find_user_id_by_email(email: str) -> str | None:
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT user_id FROM local_credentials WHERE email = ? COLLATE NOCASE", (email,)
        ).fetchone()
        return str(row["user_id"]) if row else None
    finally:
        conn.close()


def create_local_user(
    email: str,
    password: str,
    display_name: str | None = None,
    *,
    is_instance_admin: bool = False,
    can_create_spaces: bool = False,
) -> str:
    """Create (or adopt) a ``users`` row and attach local credentials. Returns the user id.

    If a human ``users`` row with the same email already exists (for example a principal
    that was invited by email, or an account from a previous Clerk-mode life of this
    catalog), the credentials are attached to that row so its memberships are preserved.
    """
    em = normalize_email(email)
    validate_password(password)
    name = (display_name or "").strip() or None
    pw_hash = hash_password(password)
    conn = _conn()
    try:
        existing = conn.execute(
            "SELECT 1 FROM local_credentials WHERE email = ? COLLATE NOCASE", (em,)
        ).fetchone()
        if existing is not None:
            raise ValueError("An account with that email already exists.")
        row = conn.execute(
            "SELECT id FROM users WHERE principal_type = 'user' AND lower(email) = ? "
            "ORDER BY creation_date LIMIT 1",
            (em,),
        ).fetchone()
        if row is not None:
            user_id = str(row["id"])
            conn.execute(
                "UPDATE users SET display_name = COALESCE(?, display_name), "
                "       is_instance_admin = CASE WHEN ? THEN 1 ELSE is_instance_admin END, "
                "       can_create_spaces = CASE WHEN ? THEN 1 ELSE can_create_spaces END, "
                "       modified_date = datetime('now') "
                "WHERE id = ?",
                (name, 1 if is_instance_admin else 0, 1 if can_create_spaces else 0, user_id),
            )
        else:
            user_id = id_generator.generate_id()
            # Legacy catalogs may still carry NOT NULL on clerk_user_id; give local users
            # a synthetic, unique, non-Clerk identifier (never a real JWT ``sub``).
            conn.execute(
                "INSERT INTO users (id, clerk_user_id, email, display_name, principal_type, "
                "                   can_create_spaces, is_instance_admin) "
                "VALUES (?, ?, ?, ?, 'user', ?, ?)",
                (
                    user_id,
                    f"local:{user_id}",
                    em,
                    name,
                    1 if can_create_spaces else 0,
                    1 if is_instance_admin else 0,
                ),
            )
        conn.execute(
            "INSERT INTO local_credentials (user_id, email, password_hash) VALUES (?, ?, ?)",
            (user_id, em, pw_hash),
        )
        conn.commit()
        return user_id
    finally:
        conn.close()


def authenticate(email: str, password: str) -> str | None:
    """Return the user id when ``email``/``password`` match, else ``None``.

    Always performs a hash comparison (against a dummy hash when the email is unknown)
    so response timing does not reveal whether an account exists.
    """
    em = (email or "").strip().lower()
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT user_id, password_hash FROM local_credentials WHERE email = ? COLLATE NOCASE",
            (em,),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        verify_password(password or "", _DUMMY_HASH)
        return None
    if not verify_password(password or "", str(row["password_hash"])):
        return None
    return str(row["user_id"])


def set_password(user_id: str, new_password: str) -> None:
    """Replace a user's password and revoke every existing session."""
    validate_password(new_password)
    pw_hash = hash_password(new_password)
    conn = _conn()
    try:
        cur = conn.execute(
            "UPDATE local_credentials SET password_hash = ?, modified_date = datetime('now') "
            "WHERE user_id = ?",
            (pw_hash, user_id),
        )
        if cur.rowcount == 0:
            raise ValueError("No local credentials exist for that user.")
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        conn.commit()
    finally:
        conn.close()


def verify_user_password(user_id: str, password: str) -> bool:
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT password_hash FROM local_credentials WHERE user_id = ?", (user_id,)
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return False
    return verify_password(password or "", str(row["password_hash"]))


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

SESSION_PREFIX = "pfs_"
SESSION_COOKIE = "pona_session"


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def create_session(user_id: str) -> str:
    """Issue a new session for ``user_id``; returns the plaintext token (stored hashed)."""
    token = SESSION_PREFIX + secrets.token_urlsafe(32)
    expires = _utcnow() + session_lifetime()
    conn = _conn()
    try:
        conn.execute(
            "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
            (id_generator.generate_id(), user_id, _hash_token(token), _iso(expires)),
        )
        # Opportunistic pruning keeps the table small without a background job.
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (_iso(_utcnow()),))
        conn.commit()
    finally:
        conn.close()
    return token


def resolve_session(token: str) -> str | None:
    """Return the user id for a live session token, else ``None``. Touches last_seen."""
    tok = (token or "").strip()
    if not tok.startswith(SESSION_PREFIX):
        return None
    token_hash = _hash_token(tok)
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT id, user_id, token_hash, expires_at FROM sessions WHERE token_hash = ?",
            (token_hash,),
        ).fetchone()
        if row is None:
            return None
        if not hmac.compare_digest(str(row["token_hash"]), token_hash):
            return None
        if str(row["expires_at"]) < _iso(_utcnow()):
            conn.execute("DELETE FROM sessions WHERE id = ?", (row["id"],))
            conn.commit()
            return None
        conn.execute(
            "UPDATE sessions SET last_seen_date = datetime('now') WHERE id = ?", (row["id"],)
        )
        conn.commit()
        return str(row["user_id"])
    finally:
        conn.close()


def revoke_session(token: str) -> None:
    tok = (token or "").strip()
    if not tok:
        return
    conn = _conn()
    try:
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash_token(tok),))
        conn.commit()
    finally:
        conn.close()


def revoke_all_sessions(user_id: str) -> None:
    conn = _conn()
    try:
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Login throttling (in-memory sliding window)
# ---------------------------------------------------------------------------

LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_MAX_FAILURES_PER_IP = 20
LOGIN_MAX_FAILURES_PER_EMAIL = 8

_failures: dict[str, list[float]] = {}
_failures_lock = threading.Lock()


def _prune(key: str, now: float) -> list[float]:
    stamps = [t for t in _failures.get(key, ()) if now - t < LOGIN_WINDOW_SECONDS]
    if stamps:
        _failures[key] = stamps
    else:
        _failures.pop(key, None)
    return stamps


def login_retry_after(ip: str, email: str) -> int:
    """Seconds the caller must wait before another login attempt, or 0 if allowed."""
    now = time.monotonic()
    with _failures_lock:
        checks = (
            (f"ip:{ip}", LOGIN_MAX_FAILURES_PER_IP),
            (f"email:{(email or '').strip().lower()}", LOGIN_MAX_FAILURES_PER_EMAIL),
        )
        wait = 0
        for key, limit in checks:
            stamps = _prune(key, now)
            if len(stamps) >= limit:
                wait = max(wait, int(LOGIN_WINDOW_SECONDS - (now - stamps[0])) + 1)
        return wait


def record_login_failure(ip: str, email: str) -> None:
    now = time.monotonic()
    with _failures_lock:
        for key in (f"ip:{ip}", f"email:{(email or '').strip().lower()}"):
            _prune(key, now)
            _failures.setdefault(key, []).append(now)


def record_login_success(ip: str, email: str) -> None:
    with _failures_lock:
        _failures.pop(f"email:{(email or '').strip().lower()}", None)
        _failures.pop(f"ip:{ip}", None)


def reset_login_throttle() -> None:
    """Test helper: forget all recorded failures."""
    with _failures_lock:
        _failures.clear()


# Computed once at import so the unknown-email path costs the same as a real check.
_DUMMY_HASH = hash_password("not-a-real-password")


def public_status() -> dict[str, Any]:
    """The unauthenticated ``/api/auth/status`` payload the UI boots from."""
    mode = auth_mode()
    status: dict[str, Any] = {
        "mode": mode,
        "setup_required": setup_required() if mode == MODE_LOCAL else False,
        "open_signup": open_signup_enabled() if mode == MODE_LOCAL else False,
        "clerk_publishable_key": None,
    }
    if mode == MODE_CLERK:
        status["clerk_publishable_key"] = (
            os.environ.get("CLERK_PUBLISHABLE_KEY")
            or os.environ.get("VITE_CLERK_PUBLISHABLE_KEY")
            or ""
        ).strip() or None
    return status
