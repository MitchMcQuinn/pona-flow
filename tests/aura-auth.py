"""Aura Free uses the instance id as user and database. Aura Pro uses neo4j.

Run: ``python tests/aura-auth.py`` from the repo root.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server.graph import aura_instance_id, auth_followups  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


URI = "neo4j+s://abcd1234.databases.neo4j.io"
check("aura host yields the instance id", aura_instance_id(URI) == "abcd1234")
check(
    "userinfo is not part of the instance id",
    aura_instance_id("neo4j+s://neo4j:secret@abcd1234.databases.neo4j.io") == "abcd1234",
)
check("local bolt has no instance id", aura_instance_id("bolt://127.0.0.1:7687") is None)
check(
    "neo4j user on Aura Free retries as the instance id",
    auth_followups(URI, "neo4j", None, "auth") == [("abcd1234", "abcd1234")],
)
check(
    "instance-id user retries Aura Pro's neo4j pair after an auth failure",
    auth_followups(URI, "abcd1234", None, "auth") == [("neo4j", "neo4j")],
)
check(
    "missing default database retries the instance database",
    auth_followups(URI, "abcd1234", None, "database") == [("abcd1234", "abcd1234")],
)
check(
    "a query error is not an auth retry",
    auth_followups(URI, "neo4j", None, "other") == [],
)
check(
    "local auth failure has no alternate",
    auth_followups("bolt://127.0.0.1:7687", "neo4j", None, "auth") == [],
)

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All checks passed.")
