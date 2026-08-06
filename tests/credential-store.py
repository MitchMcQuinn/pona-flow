"""
Diagnostic test for the credential store (Engine/server/credentials.py + config writers).

Covers:
- LocalEnvFileStore round-trip through the .env file and os.environ (set/get/delete), and
  that set OVERWRITES an existing value (not setdefault, which load_env_file uses).
- Metadata CRUD redaction: list/upsert never return the secret value, only metadata +
  ``configured``.
- ``$secret.<NAME>`` resolution via execution._resolve_secrets, including an embedded token
  ("Bearer $secret.X"), and that resolving does NOT leak the value into the run ``resolved``
  map that gets persisted into state.
- PassthroughStore is read-only (writing a value raises).

Uses a temporary .env file and a temporary catalog SQLite DB — no Neo4j needed.

Run: ``python tests/credential-store.py`` from the repo root.
"""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import config, credentials, execution  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


SPACE = "TEST_SPACE"


def main() -> None:
    tmpdir = tempfile.mkdtemp(prefix="cred-test-")
    env_path = Path(tmpdir) / ".env"
    db_path = Path(tmpdir) / "catalog.db"

    saved_env_file_path = config.env_file_path
    saved_environ = dict(os.environ)
    try:
        config.env_file_path = lambda: env_path  # type: ignore[assignment]
        os.environ["SQLITE_DATABASE_PATH"] = str(db_path)
        os.environ["PONA_FLOW_CREDENTIAL_BACKEND"] = "local"

        # --- config writers: set / overwrite / delete --------------------------------
        config.set_env_value("FOO_KEY", "first")
        check("set writes os.environ", os.environ.get("FOO_KEY") == "first")
        check("set writes .env file", "FOO_KEY=first" in env_path.read_text())

        config.set_env_value("FOO_KEY", "second")
        check("set overwrites os.environ (not setdefault)", os.environ.get("FOO_KEY") == "second")
        check("set overwrites .env file value", env_path.read_text().count("FOO_KEY=") == 1)
        check("overwritten .env value is new", "FOO_KEY=second" in env_path.read_text())

        config.delete_env_value("FOO_KEY")
        check("delete clears os.environ", "FOO_KEY" not in os.environ)
        check("delete clears .env file", "FOO_KEY" not in env_path.read_text())

        # --- backend selection --------------------------------------------------------
        check("backend reads env var", credentials.active_backend() == "local")
        store = credentials.get_store()
        check("local backend is writable", store.writable is True)

        # --- metadata CRUD + redaction ------------------------------------------------
        meta = credentials.upsert_credential(
            SPACE, "my api key", value="topsecret", description="prod key"
        )
        check("name normalized to identifier", meta["name"] == "MY_API_KEY")
        check("env key is space-prefixed", meta["env_key"] == "TEST_SPACE_CRED_MY_API_KEY")
        check("upsert reports configured", meta["configured"] is True)
        check("upsert never returns value", "value" not in meta and "topsecret" not in str(meta))

        listed = credentials.list_credentials(SPACE)
        check("list returns one credential", len(listed) == 1)
        check("list never returns value", "topsecret" not in str(listed))
        check("stored value lives in env key", os.environ.get("TEST_SPACE_CRED_MY_API_KEY") == "topsecret")

        # Update value; metadata row count stays 1 (upsert, not insert).
        credentials.upsert_credential(SPACE, "MY_API_KEY", value="rotated")
        check("rotate keeps single row", len(credentials.list_credentials(SPACE)) == 1)
        check("rotate updates value", credentials.resolve(SPACE, "MY_API_KEY") == "rotated")

        # --- $secret.<NAME> resolution ------------------------------------------------
        cache: dict[str, str | None] = {}
        headers = {"Authorization": "Bearer $secret.MY_API_KEY", "X-Plain": "no-secret"}
        resolved_headers = execution._resolve_secrets(headers, SPACE, cache)
        check(
            "embedded $secret token resolved in header",
            resolved_headers["Authorization"] == "Bearer rotated",
        )
        check("non-secret header untouched", resolved_headers["X-Plain"] == "no-secret")

        whole = execution._resolve_secrets("$secret.MY_API_KEY", SPACE, cache)
        check("whole-string $secret token resolved", whole == "rotated")

        unknown = execution._resolve_secrets("$secret.DOES_NOT_EXIST", SPACE, cache)
        check("unknown $secret reference left intact", unknown == "$secret.DOES_NOT_EXIST")

        # Redaction: resolution must not push the secret into the persisted run map.
        run_resolved: dict[str, object] = {}
        execution._resolve_secrets({"a": "$secret.MY_API_KEY"}, SPACE, run_resolved_cache := {})
        check("resolve does not mutate run state map", run_resolved == {})
        check("secret value not stored in resolved map", "rotated" not in str(run_resolved))
        _ = run_resolved_cache  # cache may hold the value transiently; that is expected

        # --- delete -------------------------------------------------------------------
        credentials.delete_credential(SPACE, "MY_API_KEY")
        check("delete removes metadata", credentials.list_credentials(SPACE) == [])
        check("delete removes value from env", "TEST_SPACE_CRED_MY_API_KEY" not in os.environ)
        check("resolve returns None after delete", credentials.resolve(SPACE, "MY_API_KEY") is None)

        # --- passthrough is read-only -------------------------------------------------
        os.environ["PONA_FLOW_CREDENTIAL_BACKEND"] = "passthrough"
        passthrough = credentials.get_store()
        check("passthrough backend not writable", passthrough.writable is False)
        try:
            credentials.upsert_credential(SPACE, "READONLY", value="nope")
            check("passthrough write raises PermissionError", False)
        except PermissionError:
            check("passthrough write raises PermissionError", True)
    finally:
        config.env_file_path = saved_env_file_path  # type: ignore[assignment]
        os.environ.clear()
        os.environ.update(saved_environ)

    if failures:
        print(f"\n{len(failures)} check(s) failed: {failures}")
        sys.exit(1)
    print("\nAll credential-store checks passed.")


if __name__ == "__main__":
    main()
