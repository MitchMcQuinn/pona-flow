"""
Collision-resistant entity ID generation for pona flow graph and catalog rows.

Purpose in the project
----------------------
New graph nodes, relationships, and catalog records need stable unique identifiers.
This module produces ``ID_<uuid4hex>`` strings (no dashes) used by:

- ``GET /api/generate-id`` — React QUERY builder and catalog row editor assign new ids
- Any future server logic that needs a client-visible id before persistence

The format matches pona flow conventions (``ID_`` prefix + 32 hex chars).

Importance
----------
Kept as its own module so ID policy lives in one place. If the project later adopts
a different scheme (sequential ids, ULIDs), only this file changes.

CLI::

  python Engine/server/id_generator.py
"""

from __future__ import annotations

import uuid


def generate_id() -> str:
    """Return a new unique ID string."""
    return f"ID_{uuid.uuid4().hex}"


def main() -> None:
    print(generate_id())


if __name__ == "__main__":
    main()
