"""
Operator tool: reset a built-in (local auth) account's password, or promote it to admin.

Use this when an administrator is locked out of a self-hosted instance. It writes to the
catalog SQLite database directly, so run it on the host (or inside the container) that
owns ``data.db``; the running server picks the change up immediately and every existing
session for that account is revoked.

Usage (from the repository root, project venv or container shell)
-------------------------------------------------------------------
    python tools/reset_password.py user@example.com            # prompt for a new password
    python tools/reset_password.py user@example.com --make-admin
    python tools/reset_password.py --list                      # show local accounts

Docker:
    docker compose exec pona-flow python tools/reset_password.py user@example.com
"""

from __future__ import annotations

import argparse
import getpass
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "Engine"))

from server import config, local_auth  # noqa: E402


def _list_accounts() -> int:
    conn = config.connect_sqlite(config.catalog_sqlite_path())
    try:
        rows = conn.execute(
            "SELECT lc.email, u.display_name, u.is_instance_admin, lc.creation_date "
            "FROM local_credentials lc JOIN users u ON u.id = lc.user_id "
            "ORDER BY lc.creation_date"
        ).fetchall()
    except sqlite3.OperationalError:
        print("No local accounts table yet (start the server once to run migrations).")
        return 1
    finally:
        conn.close()
    if not rows:
        print("No local accounts. Open the app in a browser to run first-time setup.")
        return 0
    for r in rows:
        flag = "admin" if r["is_instance_admin"] else "user"
        print(f"{r['email']:<40} {flag:<6} {r['display_name'] or ''}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("email", nargs="?", help="account email")
    parser.add_argument("--list", action="store_true", help="list local accounts and exit")
    parser.add_argument("--make-admin", action="store_true", help="also grant instance admin")
    parser.add_argument("--password", help="new password (prompted when omitted)")
    args = parser.parse_args()

    config.load_env_file(config.ROOT / ".env")
    data_dir_env = config.data_dir() / ".env" if hasattr(config, "data_dir") else None
    if data_dir_env is not None:
        config.load_env_file(data_dir_env)

    if args.list:
        return _list_accounts()
    if not args.email:
        parser.error("email is required (or use --list)")

    user_id = local_auth.find_user_id_by_email(args.email)
    if user_id is None:
        print(f"No local account for {args.email!r}.", file=sys.stderr)
        return 1

    password = args.password
    if password is None:
        password = getpass.getpass("New password: ")
        if password != getpass.getpass("Repeat new password: "):
            print("Passwords do not match.", file=sys.stderr)
            return 1
    try:
        local_auth.set_password(user_id, password)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 1
    print(f"Password updated for {args.email}; all sessions signed out.")

    if args.make_admin:
        conn = config.connect_sqlite(config.catalog_sqlite_path())
        try:
            conn.execute(
                "UPDATE users SET is_instance_admin = 1, can_create_spaces = 1, "
                "modified_date = datetime('now') WHERE id = ?",
                (user_id,),
            )
            conn.commit()
        finally:
            conn.close()
        print(f"{args.email} is now an instance admin.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
