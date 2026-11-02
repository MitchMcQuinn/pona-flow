"""Mint a one-time VIP code. The plaintext is printed once and only the hash is stored."""

from __future__ import annotations

import os
import secrets

from .db import Database
from .lifecycle import vip_code_hash


def main() -> None:
    path = (os.environ.get("CONTROL_PLANE_DB") or "control-plane.db").strip()
    code = secrets.token_urlsafe(18)
    Database(path).insert_vip(vip_code_hash(code))
    print(code)


if __name__ == "__main__":
    main()
