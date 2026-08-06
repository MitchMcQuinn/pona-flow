"""
Diagnostic: pure-logic checks for the SCHEMA-change suspension cascade
(Engine/server/schema_suspension.py).

Covers the parts that don't touch the DB/graph:
  - _where_property_keys: pull filter keys out of (nested) WHERE groups
  - _instance_targets: which INSTANCE labels an op touches + its bound/filter keys
  - schema_key_sets_from_schemata: (all keys, non-key keys) from a schemata list
  - _operation_drifts: the create-vs-read/update "affected" predicate

Run:  .venv/bin/python tests/schema-suspension-logic.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from Engine.server import schema_suspension as ss  # noqa: E402

failures: list[str] = []


def check(name: str, got, want) -> None:
    if got != want:
        failures.append(f"{name}: got {got!r}, want {want!r}")


# --- _where_property_keys -------------------------------------------------
where = {
    "operator": "AND",
    "items": [
        {"property_key": "email", "operator": "=", "value": "x"},
        {
            "operator": "OR",
            "items": [
                {"property_key": "status", "operator": "=", "value": "a"},
                {"expression": "n.foo > 1"},  # raw WhereCondition: no property_key
            ],
        },
    ],
}
check("where_keys", ss._where_property_keys(where), {"email", "status"})
check("where_keys_none", ss._where_property_keys(None), set())


# --- _instance_targets ----------------------------------------------------
# A read op over a PERSON instance, filtered on a (now-deleted) property.
read_config = {
    "query": {
        "operation": "read",
        "match": [
            {
                "label": "INSTANCE",
                "patterns": [
                    {
                        "path": [
                            {
                                "kind": "node",
                                "node": {
                                    "attributive_label": "PERSON",
                                    "properties": [],
                                    "where": {
                                        "operator": "AND",
                                        "items": [
                                            {"property_key": "nickname", "operator": "=", "value": "x"}
                                        ],
                                    },
                                },
                            }
                        ]
                    }
                ],
            }
        ],
    }
}
targets = ss._instance_targets(read_config)
check("read_targets_labels", set(targets.keys()), {"PERSON"})
check("read_targets_filter_keys", targets["PERSON"]["filter_keys"], {"nickname"})

# A create op binding name + email (parameterized label is ignored).
create_config = {
    "query": {
        "operation": "create",
        "match": [
            {
                "label": "INSTANCE",
                "patterns": [
                    {
                        "path": [
                            {
                                "kind": "node",
                                "node": {
                                    "attributive_label": "PERSON",
                                    "properties": [
                                        {"key": "name", "value": "x"},
                                        {"key": "email", "value": "y"},
                                    ],
                                },
                            }
                        ]
                    }
                ],
            },
            {
                "label": "INSTANCE",
                "patterns": [
                    {"path": [{"kind": "node", "node": {"attributive_label": "$param"}}]}
                ],
            },
        ],
    }
}
ctargets = ss._instance_targets(create_config)
check("create_targets_labels", set(ctargets.keys()), {"PERSON"})
check("create_bound_keys", ctargets["PERSON"]["bound_keys"], {"name", "email"})
check("create_creates_flag", ctargets["PERSON"]["creates"], True)

# A connection-style create: two matched-existing endpoints joined by a new relationship
# (modeled on CREATE_PILLAR_VALUE_CONNECTION). Endpoints must not adopt properties.
connection_config = {
    "query": {
        "operation": "create",
        "match": [
            {
                "label": "INSTANCE",
                "patterns": [
                    {
                        "path": [
                            {
                                "kind": "node",
                                "node": {
                                    "attributive_label": "PILLAR",
                                    "node_source": "existing",
                                    "properties": [],
                                    "id_binding": {"key": "id", "value": "$pillarID"},
                                },
                            },
                            {
                                "kind": "relationship",
                                "relationship": {
                                    "type": "POINTS_TO",
                                    "attributive_label": "HAS_MANY",
                                    "node_source": "new",
                                    "properties": [{"key": "id", "value": "ID_x"}],
                                },
                            },
                            {
                                "kind": "node",
                                "node": {
                                    "attributive_label": "VALUE",
                                    "node_source": "existing",
                                    "properties": [],
                                    "id_binding": {"key": "id", "value": "$valueID"},
                                },
                            },
                        ]
                    }
                ],
            }
        ],
    }
}
ntargets = ss._instance_targets(connection_config)
check("connection_targets_labels", set(ntargets.keys()), {"PILLAR", "VALUE"})
check("connection_pillar_creates", ntargets["PILLAR"]["creates"], False)
check("connection_value_creates", ntargets["VALUE"]["creates"], False)
check("connection_pillar_bound", ntargets["PILLAR"]["bound_keys"], set())
check("connection_pillar_filters", ntargets["PILLAR"]["filter_keys"], {"id"})
check("connection_value_filters", ntargets["VALUE"]["filter_keys"], {"id"})


# --- schema_key_sets_from_schemata ---------------------------------------
schemata = [
    {"key": "id", "is_key": True},
    {"key": "name", "is_key": False},
    {"key": "email", "is_key": False},
]
keys, nonkey = ss.schema_key_sets_from_schemata(schemata)
check("schema_all_keys", keys, {"id", "name", "email"})
check("schema_nonkey_keys", nonkey, {"name", "email"})


# --- _operation_drifts: create --------------------------------------------
schema_keys = {"id", "name", "email"}
schema_nonkey = {"name", "email"}

# Conforming create (binds exactly the non-key set) -> no drift.
check(
    "create_conforms",
    ss._operation_drifts(
        {"bound_keys": {"name", "email"}, "creates": True}, "create", schema_keys, schema_nonkey
    ),
    False,
)
# Binds a property the schema deleted -> drift.
check(
    "create_extra_prop",
    ss._operation_drifts(
        {"bound_keys": {"name", "email", "nickname"}, "creates": True},
        "create",
        schema_keys,
        schema_nonkey,
    ),
    True,
)
# Missing a (newly added) non-key property -> drift.
check(
    "create_missing_prop",
    ss._operation_drifts(
        {"bound_keys": {"name"}, "creates": True}, "create", schema_keys, schema_nonkey
    ),
    True,
)
# Matched-existing endpoint in a create op (no adoption) -> no drift.
check(
    "create_existing_endpoint",
    ss._operation_drifts(
        {"bound_keys": set(), "filter_keys": {"id"}, "creates": False},
        "create",
        schema_keys,
        schema_nonkey,
    ),
    False,
)
# Matched endpoint filtered on a deleted property -> drift.
check(
    "create_existing_deleted_filter",
    ss._operation_drifts(
        {"bound_keys": set(), "filter_keys": {"nickname"}, "creates": False},
        "create",
        schema_keys,
        schema_nonkey,
    ),
    True,
)


# --- _operation_drifts: read/update --------------------------------------
# Filter references a deleted property -> affected.
check(
    "read_filter_deleted",
    ss._operation_drifts({"filter_keys": {"nickname"}}, "read", schema_keys, schema_nonkey),
    True,
)
# Filter on a still-present property -> not affected.
check(
    "read_filter_present",
    ss._operation_drifts({"filter_keys": {"email"}}, "read", schema_keys, schema_nonkey),
    False,
)
# A new property was ADDED (schema grew); read filter unaffected.
check(
    "read_added_prop_unaffected",
    ss._operation_drifts({"filter_keys": {"name"}}, "update", {"id", "name", "phone"}, {"name", "phone"}),
    False,
)
# No filters at all -> read/update never affected.
check(
    "read_no_filters",
    ss._operation_drifts({"filter_keys": set()}, "update", schema_keys, schema_nonkey),
    False,
)


if failures:
    print("FAIL")
    for f in failures:
        print("  -", f)
    sys.exit(1)
print("PASS: schema-suspension logic")
