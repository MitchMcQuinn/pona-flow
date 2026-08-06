"""
Diagnostic test for the code resources store (Engine/server/resources.py).

Covers:
- create / read / update / delete round trip (catalog row + gitignored code file);
- server-derived storage paths (client input never becomes a path; traversal guard);
- space scoping: one space can never read, update, or execute another space's resource;
- create-with-provided-id (builder retry idempotency) and the cross-space id guard;
- language switch rewrites the file extension and removes the stale file;
- code size cap and language validation;
- load_for_execution fails clearly when the file is missing from disk.

Uses a temporary catalog DB and a temporary resources dir — no Docker/Neo4j needed.

Run: ``.venv/bin/python tests/resources-store.py`` from the repo root.
"""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server import config, resources  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


def main() -> None:
    tmpdir = tempfile.mkdtemp(prefix="resources-test-")
    db_path = Path(tmpdir) / "catalog.db"
    res_dir = Path(tmpdir) / "resources"
    saved_environ = dict(os.environ)
    saved_catalog_path = config.catalog_sqlite_path
    try:
        os.environ["PONA_FLOW_RESOURCES_DIR"] = str(res_dir)
        config.catalog_sqlite_path = lambda: db_path  # type: ignore[assignment]

        # --- create ---------------------------------------------------------------
        meta = resources.upsert_resource(
            "SPACE_A", name="My Script", code="print('hi')", language="python",
            description="demo",
        )
        rid = meta["id"]
        check("create returns an ID_ uid", rid.startswith("ID_"))
        check("path is server-derived and space-scoped", meta["path"] == f"code/SPACE_A/{rid}.py")
        file_path = res_dir / meta["path"]
        check("code file written under resources dir", file_path.is_file())
        check("code file content matches", file_path.read_text() == "print('hi')")

        # --- read -------------------------------------------------------------------
        got = resources.get_resource("SPACE_A", rid)
        check("get returns code + metadata", got["code"] == "print('hi')" and got["name"] == "My Script")

        # --- update in place ----------------------------------------------------------
        resources.upsert_resource(
            "SPACE_A", name="My Script v2", code="print('v2')", language="python",
            resource_id=rid,
        )
        got = resources.get_resource("SPACE_A", rid)
        check("update rewrites code and name", got["code"] == "print('v2')" and got["name"] == "My Script v2")
        check("update keeps a single row", len(resources.list_resources("SPACE_A")) == 1)

        # --- language switch rewrites the file -----------------------------------------
        resources.upsert_resource(
            "SPACE_A", name="My Script v2", code="console.log(1)", language="javascript",
            resource_id=rid,
        )
        got = resources.get_resource("SPACE_A", rid)
        check("language switch updates path extension", got["path"].endswith(".js"))
        check("stale .py file removed on language switch", not file_path.exists())

        # --- space scoping ---------------------------------------------------------------
        cross_read_blocked = False
        try:
            resources.get_resource("SPACE_B", rid)
        except KeyError:
            cross_read_blocked = True
        check("cross-space read rejected", cross_read_blocked)

        cross_update_blocked = False
        try:
            resources.upsert_resource(
                "SPACE_B", name="steal", code="x", language="python", resource_id=rid
            )
        except KeyError:
            cross_update_blocked = True
        check("cross-space update (id collision) rejected", cross_update_blocked)

        cross_exec_blocked = False
        try:
            resources.load_for_execution("SPACE_B", rid)
        except KeyError:
            cross_exec_blocked = True
        check("cross-space execution load rejected", cross_exec_blocked)

        # --- create with a provided id (builder retry idempotency) -----------------------
        provided = "ID_deadbeefdeadbeefdeadbeefdeadbeef"
        meta2 = resources.upsert_resource(
            "SPACE_B", name="Stable", code="result = 1", language="python",
            resource_id=provided,
        )
        check("provided id creates when missing", meta2["id"] == provided)
        meta3 = resources.upsert_resource(
            "SPACE_B", name="Stable", code="result = 2", language="python",
            resource_id=provided,
        )
        check("retry with same id updates in place", meta3["id"] == provided)
        check("retry leaves a single row", len(resources.list_resources("SPACE_B")) == 1)

        # --- validation --------------------------------------------------------------------
        bad_lang = False
        try:
            resources.upsert_resource("SPACE_A", name="x", code="y", language="ruby")
        except ValueError:
            bad_lang = True
        check("unsupported language rejected", bad_lang)

        too_big = False
        try:
            resources.upsert_resource(
                "SPACE_A", name="big", code="x" * (resources.MAX_CODE_BYTES + 1),
                language="python",
            )
        except ValueError:
            too_big = True
        check("oversized code rejected", too_big)

        bad_id = False
        try:
            resources.get_resource("SPACE_A", "../../etc/passwd")
        except ValueError:
            bad_id = True
        check("path-traversal-shaped id rejected", bad_id)

        traversal_blocked = False
        try:
            resources._absolute_path("../outside.py")
        except ValueError:
            traversal_blocked = True
        check("stored path escaping resources dir rejected", traversal_blocked)

        # --- missing file surfaces a clear execution error -----------------------------------
        (res_dir / meta3["path"]).unlink()
        missing_file = False
        try:
            resources.load_for_execution("SPACE_B", provided)
        except KeyError:
            missing_file = True
        check("missing code file fails execution load clearly", missing_file)

        # --- delete -----------------------------------------------------------------------------
        result = resources.delete_resource("SPACE_A", rid)
        check("delete reports deleted", result["deleted"] is True)
        check("delete removes the row", len(resources.list_resources("SPACE_A")) == 0)
        check("delete is idempotent", resources.delete_resource("SPACE_A", rid)["deleted"] is True)

    finally:
        config.catalog_sqlite_path = saved_catalog_path
        os.environ.clear()
        os.environ.update(saved_environ)

    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED: " + ", ".join(failures))
        sys.exit(1)
    print("All resources-store checks passed.")


if __name__ == "__main__":
    main()
