"""Small helpers shared by the control plane. No network."""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone

SANDBOX_DAYS = 7
GRACE_DAYS = 7
MIN_PASSWORD_LENGTH = 10
REGIONS = ("iad", "ord", "lax", "lhr", "fra", "syd", "nrt")
PUBLIC_SANDBOX_CODE = "sandbox"
GITHUB_REPO = "https://github.com/MitchMcQuinn/pona-flow"
SELF_HOSTED_IMAGE = "ghcr.io/mitchmcquinn/pona-flow:main"
HOSTED_IMAGE = "ghcr.io/mitchmcquinn/pona-flow-hosted:main"

ACTIVE_SANDBOX_STATUSES = ("pending_payment", "provisioning", "running", "suspended", "failed")


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def plus_days(moment: datetime, days: int) -> str:
    return iso(moment + timedelta(days=days))


def new_id() -> str:
    return secrets.token_hex(8)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1)
    return "scrypt$" + salt.hex() + "$" + digest.hex()


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, salt_hex, digest_hex = stored.split("$", 2)
    except ValueError:
        return False
    if scheme != "scrypt":
        return False
    digest = hashlib.scrypt(password.encode("utf-8"), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1)
    return hmac.compare_digest(digest.hex(), digest_hex)


def _secret_key() -> bytes:
    secret = (os.environ.get("CONTROL_PLANE_SECRET") or "").strip()
    if not secret:
        raise RuntimeError("CONTROL_PLANE_SECRET is not set")
    return hashlib.sha256(secret.encode("utf-8")).digest()


def _keystream(key: bytes, nonce: bytes, size: int) -> bytes:
    chunks = bytearray()
    counter = 0
    while len(chunks) < size:
        chunks.extend(hmac.new(key, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest())
        counter += 1
    return bytes(chunks[:size])


def encrypt_secret(plain: str) -> str:
    """Encrypt a fleet-generated Neo4j password. Self-hosted secrets never use this."""
    key = _secret_key()
    nonce = secrets.token_bytes(16)
    raw = plain.encode("utf-8")
    stream = _keystream(key, nonce, len(raw))
    cipher = bytes(a ^ b for a, b in zip(raw, stream))
    mac = hmac.new(key, nonce + cipher, hashlib.sha256).digest()
    return base64.b64encode(nonce + mac + cipher).decode("ascii")


def decrypt_secret(stored: str) -> str:
    key = _secret_key()
    blob = base64.b64decode(stored.encode("ascii"))
    nonce, mac, cipher = blob[:16], blob[16:48], blob[48:]
    expected = hmac.new(key, nonce + cipher, hashlib.sha256).digest()
    if not hmac.compare_digest(mac, expected):
        raise ValueError("encrypted secret failed verification")
    stream = _keystream(key, nonce, len(cipher))
    return bytes(a ^ b for a, b in zip(cipher, stream)).decode("utf-8")


def normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def valid_email(email: str) -> bool:
    text = normalize_email(email)
    if "@" not in text or text.startswith("@") or text.endswith("@"):
        return False
    local, _, domain = text.partition("@")
    return bool(local) and "." in domain and " " not in text


def valid_app_slug(name: str) -> bool:
    text = (name or "").strip().lower()
    if len(text) < 2 or len(text) > 30:
        return False
    if text[0] == "-" or text[-1] == "-":
        return False
    return all(ch.isalnum() or ch == "-" for ch in text) and any(ch.isalnum() for ch in text)


def fleet_app_name(slug: str) -> str:
    return "pf-" + slug.strip().lower()


def valid_region(region: str) -> bool:
    return (region or "").strip().lower() in REGIONS


def aura_uri_ok(uri: str) -> bool:
    text = (uri or "").strip()
    return text.startswith("neo4j+s://") or text.startswith("bolt+s://")


def aura_instance_id(uri: str) -> str:
    """First label of ``*.databases.neo4j.io``, or empty when the host is not Aura.

    Aura Free uses this id as the database user. Aura Pro uses ``neo4j``.
    """
    text = (uri or "").strip()
    if "://" not in text:
        return ""
    host = text.split("://", 1)[1].split("/")[0].split("?")[0].split("@")[-1]
    if host.startswith("["):
        return ""
    host = host.split(":")[0]
    suffix = ".databases.neo4j.io"
    if not host.lower().endswith(suffix):
        return ""
    label = host[: -len(suffix)]
    if not label or "." in label:
        return ""
    return label
