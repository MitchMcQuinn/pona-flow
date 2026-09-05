"""
Loopback neo4j:// URIs must connect with bolt://.

A local Desktop/Community DBMS is not a cluster. The neo4j:// scheme asks for a
routing table and fails with "Unable to retrieve routing information" — the error
the builder shows on attributive_label uniqueness after "+ ADD NEW NODE".

Run: ``python tests/neo4j-direct-bolt-uri.py`` from the repo root.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from Engine.server.graph import _neo4j_connect_error, direct_bolt_uri  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        failures.append(name)


check(
    "127.0.0.1 neo4j:// rewrites to bolt://",
    direct_bolt_uri("neo4j://127.0.0.1:7687") == "bolt://127.0.0.1:7687",
)
check(
    "localhost neo4j:// rewrites to bolt://",
    direct_bolt_uri("neo4j://localhost:7687") == "bolt://localhost:7687",
)
check(
    "IPv6 loopback neo4j:// rewrites to bolt://",
    direct_bolt_uri("neo4j://[::1]:7687") == "bolt://[::1]:7687",
)
check(
    "already-bolt loopback is unchanged",
    direct_bolt_uri("bolt://127.0.0.1:7687") == "bolt://127.0.0.1:7687",
)
check(
    "remote neo4j:// (Aura/cluster) is unchanged",
    direct_bolt_uri("neo4j://db.example.com:7687") == "neo4j://db.example.com:7687",
)
check(
    "neo4j+s:// is unchanged",
    direct_bolt_uri("neo4j+s://db.example.com") == "neo4j+s://db.example.com",
)

err = _neo4j_connect_error(RuntimeError("Unable to retrieve routing information"))
check(
    "routing failure mentions bolt://",
    "bolt://127.0.0.1:7687" in str(err) and "neo4j://" in str(err),
)
other = _neo4j_connect_error(RuntimeError("Constraint validation failed"))
check(
    "other Neo4j errors stay wrapped",
    str(other) == "Neo4j error: Constraint validation failed",
)

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All checks passed.")
