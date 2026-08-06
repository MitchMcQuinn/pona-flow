"""
Diagnostic test for the template import plan materializer (server.templates).

The import runner regenerates every id and rewrites embedded id/label references before
executing, so the transform is the riskiest part of the feature. This exercises the pure
plan-building helpers and the selection-closure resolver (no Neo4j / SQLite needed; the
resolver's data sources are stubbed):

- _collect_ids gathers node/rel/entity/query/event/resource ids plus ids embedded in cypher
- _build_remaps splits user renames into label vs regex maps
- _materialize_plan regenerates ids, applies label/regex remaps, orders resource+credential
  ops first, then SCHEMA -> STEP -> INSTANCE before relationships
- _rewrite_text rewrites ids and quoted labels in raw statements (incl. a code step's
  resource_id reference)
- resolve_selection walks a selected sequence to its steps, nested operation/sequence,
  schema network (endpoint pull-in), regex formats, code resources, and credential slots

Run: `python tests/template-plan-runner.py` from the repo root.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# templates_export is patched (not the templates facade) where the resolver's
# internal helpers are stubbed: internal calls resolve against the defining
# module's globals. Module-attribute patches (templates.graph.*, templates.catalog.*)
# hit the shared module objects and need no retargeting.
from Engine.server import templates, templates_export  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    print(f"[{'PASS' if condition else 'FAIL'}] {name}")
    if not condition:
        failures.append(name)


SCHEMA_ID = "ID_" + "a" * 32
STEP_ID = "ID_" + "b" * 32
INSTANCE_ID = "ID_" + "c" * 32
REL_ID = "ID_" + "d" * 32
ENTITY_ID = "ID_" + "e" * 32
QUERY_ID = "ID_" + "f" * 32
EVENT_ID = "ID_" + "0" * 32
EMBEDDED_ID = "ID_" + "1" * 32
RESOURCE_ID = "ID_" + "2" * 32
CODE_ENTITY_ID = "ID_" + "3" * 32

TEMPLATE = {
    "template_id": "ID_" + "9" * 32,
    "graph": {
        "schema_nodes": [{"id": SCHEMA_ID, "attributive_label": "PERSON", "properties": {"id": SCHEMA_ID, "attributive_label": "PERSON"}}],
        "step_nodes": [{"id": STEP_ID, "attributive_label": "DoThing", "properties": {"id": STEP_ID, "attributive_label": "DoThing"}}],
        "instance_nodes": [
            {
                "id": INSTANCE_ID,
                "attributive_label": "PERSON",
                "properties": {"id": INSTANCE_ID, "attributive_label": "PERSON", "name": "Ada"},
            }
        ],
        "relationships": [
            {
                "id": REL_ID,
                "attributive_label": "KNOWS",
                "source": INSTANCE_ID,
                "target": INSTANCE_ID,
                "properties": {"id": REL_ID, "attributive_label": "KNOWS"},
            }
        ],
    },
    "resources": [
        {
            "id": RESOURCE_ID,
            "name": "fetch_user",
            "description": "calls an API",
            "language": "python",
            "code": "headers = {'Authorization': '$secret.API_KEY'}",
        }
    ],
    "credentials": [{"name": "API_KEY", "description": "third-party API key"}],
    "sqlite": {
        "entities": [
            {
                "id": ENTITY_ID,
                "node_label": "SCHEMA",
                "common_label": "PERSON",
                "parameters": "[]",
                "payload": '{"schemata": []}',
            },
            {
                "id": CODE_ENTITY_ID,
                "node_label": "STEP",
                "common_label": "CodeStep",
                "parameters": "[]",
                "payload": '{"kind": "code", "resource_id": "' + RESOURCE_ID + '"}',
            },
        ],
        "queries": [
            {
                "id": QUERY_ID,
                "name": "PersonSeq",
                "kind": "sequence",
                "operation": "read",
                "runtime_enabled": 1,
                "author_selectable": 1,
                "triggerable": 1,
                "group_title": "People",
                "cypher": [f"MATCH (n:STEP {{id: '{EMBEDDED_ID}', attributive_label: 'PERSON'}}) RETURN n"],
                "sqlite": [],
                "parameters": [],
                "builder_config": {},
                "description": "",
            }
        ],
        "regex": [{"name": "email", "regex": "^.+@.+$"}],
        "events": [
            {
                "id": EVENT_ID,
                "name": "Nightly",
                "type": "time",
                "enabled": 1,
                "event_package": {},
                "external_package": {},
                "sequences": [QUERY_ID],
                "recovery_sequences": [],
            }
        ],
    },
}

# --- selection helpers -------------------------------------------------------------------
sel = templates._normalize_selection({"sequences": ["A", "A", " B "], "schemas": ["S"]})
check("_normalize_selection dedupes + trims", sel["sequences"] == ["A", "B"])
check("_normalize_selection fills missing keys", sel["operations"] == [] and sel["events"] == [])
check("_cypher_traverses_downstream true on hop", templates._cypher_traverses_downstream(["(a)-[:POINTS_TO]->(b)"]))
check("_cypher_traverses_downstream false on single", not templates._cypher_traverses_downstream(["MATCH (n) RETURN n"]))
bc_labels = templates._labels_in_builder_config(
    {"node_label": "PERSON", "children": [{"target_label": "COMPANY"}], "x": 1}
)
check("_labels_in_builder_config walks nested labels", bc_labels == {"PERSON", "COMPANY"})
fmts = templates._formats_in_parameters([{"format": "email"}, {"format": "any"}, {}])
check("_formats_in_parameters skips 'any'/missing", fmts == {"email"})

# --- _collect_ids ------------------------------------------------------------------------
ids = templates._collect_ids(TEMPLATE)
for label, ident in [
    ("schema", SCHEMA_ID),
    ("step", STEP_ID),
    ("instance", INSTANCE_ID),
    ("rel", REL_ID),
    ("entity", ENTITY_ID),
    ("query", QUERY_ID),
    ("event", EVENT_ID),
    ("embedded cypher id", EMBEDDED_ID),
    ("resource", RESOURCE_ID),
]:
    check(f"_collect_ids includes {label} id", ident in ids)

# --- _build_remaps -----------------------------------------------------------------------
label_remap, regex_remap = templates._build_remaps(
    [
        {"kind": "graph_label", "original_name": "PERSON", "new_name": "HUMAN"},
        {"kind": "sequence_name", "original_name": "PersonSeq", "new_name": "HumanSeq"},
        {"kind": "regex", "original_name": "email", "new_name": "email_2"},
        {"kind": "graph_label", "original_name": "X", "new_name": "X"},  # no-op (same)
    ]
)
check("label remap captures graph_label", label_remap.get("PERSON") == "HUMAN")
check("label remap captures sequence_name", label_remap.get("PersonSeq") == "HumanSeq")
check("regex remap captures regex", regex_remap.get("email") == "email_2")
check("no-op rename is dropped", "X" not in label_remap)

# --- _rewrite_text -----------------------------------------------------------------------
rewritten = templates._rewrite_text(
    f"MATCH (n {{id: '{SCHEMA_ID}', attributive_label: 'PERSON'}})",
    {SCHEMA_ID: "ID_new"},
    {"PERSON": "HUMAN"},
)
check("_rewrite_text replaces id", "ID_new" in rewritten and SCHEMA_ID not in rewritten)
check("_rewrite_text replaces quoted label", "'HUMAN'" in rewritten and "'PERSON'" not in rewritten)

# --- _materialize_plan -------------------------------------------------------------------
id_remap = {old: f"NEW_{i}" for i, old in enumerate(sorted(templates._collect_ids(TEMPLATE)))}
plan = templates._materialize_plan(
    TEMPLATE, id_remap=id_remap, label_remap=label_remap, regex_remap=regex_remap
)
stmts = plan["statements"]
ops = [s["op"] for s in stmts]

cypher_stmts = [s for s in stmts if s["op"] == "cypher"]
schema_idx = next(i for i, s in enumerate(cypher_stmts) if ":SCHEMA" in s["cypher"])
instance_idx = next(i for i, s in enumerate(cypher_stmts) if ":INSTANCE" in s["cypher"])
rel_idx = next(i for i, s in enumerate(cypher_stmts) if "POINTS_TO" in s["cypher"])
check("SCHEMA node created before INSTANCE", schema_idx < instance_idx)
check("relationship created after INSTANCE", rel_idx > instance_idx)

schema_stmt = cypher_stmts[schema_idx]
check("schema id regenerated", schema_stmt["params"]["id"] == id_remap[SCHEMA_ID])
check("schema label remapped", schema_stmt["params"]["attributive_label"] == "HUMAN")

instance_stmt = next(s for s in cypher_stmts if ":INSTANCE" in s["cypher"])
check("instance label remapped to schema", instance_stmt["params"]["props"]["attributive_label"] == "HUMAN")
check("instance data property preserved", instance_stmt["params"]["props"]["name"] == "Ada")

rel_stmt = next(s for s in cypher_stmts if "POINTS_TO" in s["cypher"])
check("relationship endpoints remapped", rel_stmt["params"]["source"] == id_remap[INSTANCE_ID])

entity_stmt = next(s for s in stmts if s["op"] == "entity")
check("entity id regenerated", entity_stmt["row"]["id"] == id_remap[ENTITY_ID])
check("entity common_label remapped (SCHEMA)", entity_stmt["row"]["common_label"] == "HUMAN")

query_stmt = next(s for s in stmts if s["op"] == "query")
check("sequence name remapped", query_stmt["row"]["name"] == "HumanSeq")
check("query embedded id rewritten", id_remap[EMBEDDED_ID] in query_stmt["row"]["cypher"][0])
check("query embedded label rewritten", "'HUMAN'" in query_stmt["row"]["cypher"][0])

regex_stmt = next(s for s in stmts if s["op"] == "regex")
check("regex renamed", regex_stmt["row"]["name"] == "email_2")

event_stmt = next(s for s in stmts if s["op"] == "event")
check("event id regenerated", event_stmt["row"]["id"] == id_remap[EVENT_ID])
check("event sequence ref remapped", event_stmt["row"]["sequences"] == [id_remap[QUERY_ID]])

check("created_labels collected", set(plan["created_labels"]) >= {"HUMAN", "DoThing", "KNOWS"})
check("group titles collected", plan["group_titles"] == ["People"])

# resource + credential ops run first (before any graph create), with the id regenerated.
first_cypher = ops.index("cypher")
check("resource op present", "resource" in ops)
check("credential op present", "credential" in ops)
check("resource op before cypher", ops.index("resource") < first_cypher)
check("credential op before cypher", ops.index("credential") < first_cypher)

resource_stmt = next(s for s in stmts if s["op"] == "resource")
check("resource id regenerated", resource_stmt["row"]["id"] == id_remap[RESOURCE_ID])
check("resource code preserved", "$secret.API_KEY" in resource_stmt["row"]["code"])

credential_stmt = next(s for s in stmts if s["op"] == "credential")
check("credential slot name carried", credential_stmt["row"]["name"] == "API_KEY")

code_entity_stmt = next(
    s for s in stmts if s["op"] == "entity" and s["row"]["id"] == id_remap[CODE_ENTITY_ID]
)
check(
    "code step payload resource_id rewritten",
    id_remap[RESOURCE_ID] in str(code_entity_stmt["row"]["payload"])
    and RESOURCE_ID not in str(code_entity_stmt["row"]["payload"]),
)

# --- resolve_selection (data sources stubbed) --------------------------------------------
SEQ1, SEQ2, OP1 = "ID_seq1", "ID_seq2", "ID_op1"
S1, S2, S3, S4, S_S2 = "ID_s1", "ID_s2", "ID_s3", "ID_s4", "ID_ss2"
PERSON_NODE, COMPANY_NODE = "ID_person", "ID_company"
WORKS_AT_REL = "ID_worksat"

FLOW = {
    "nodes": [
        {"id": S1, "attributive_label": "EntryStep", "payload": {}},
        {
            "id": S2,
            "attributive_label": "CodeStep",
            "payload": {
                "kind": "code",
                "resource_id": "ID_res1",
                "headers": "Authorization: $secret.API_KEY",
            },
        },
        {"id": S3, "attributive_label": "OpStep", "payload": {"query_id": OP1}},
        {"id": S4, "attributive_label": "NestStep", "payload": {"query_id": SEQ2}},
        {"id": S_S2, "attributive_label": "S2Entry", "payload": {}},
    ],
    "relationships": [
        {"id": "R12", "attributive_label": "e1", "source": S1, "target": S2},
        {"id": "R23", "attributive_label": "e2", "source": S2, "target": S3},
        {"id": "R34", "attributive_label": "e3", "source": S3, "target": S4},
    ],
}

QUERY_PACKAGES = {
    SEQ1: {"cypher": ["MATCH (s:STEP {attributive_label: 'EntryStep'})-[:POINTS_TO]->(x) RETURN s"]},
    SEQ2: {"cypher": ["MATCH (s:STEP {attributive_label: 'S2Entry'}) RETURN s"]},
    OP1: {
        "cypher": ["MERGE (p {attributive_label: 'PERSON'})-[:POINTS_TO {attributive_label: 'WORKS_AT'}]->(c)"]
    },
}
COMPOSE_KIND = {OP1: {"kind": "operation"}, SEQ2: {"kind": "sequence"}}
QUERY_ROWS = {
    SEQ1: {"id": SEQ1, "kind": "sequence", "cypher": QUERY_PACKAGES[SEQ1]["cypher"], "builder_config": {}, "parameters": []},
    SEQ2: {"id": SEQ2, "kind": "sequence", "cypher": QUERY_PACKAGES[SEQ2]["cypher"], "builder_config": {}, "parameters": []},
    OP1: {
        "id": OP1,
        "kind": "operation",
        "cypher": QUERY_PACKAGES[OP1]["cypher"],
        "builder_config": {},
        "parameters": [{"format": "phone"}],
    },
}
SCHEMA_NODES = [
    {"id": PERSON_NODE, "attributive_label": "PERSON"},
    {"id": COMPANY_NODE, "attributive_label": "COMPANY"},
]
SCHEMA_RELS = [
    {"id": WORKS_AT_REL, "attributive_label": "WORKS_AT", "source": PERSON_NODE, "target": COMPANY_NODE}
]
SCHEMA_DEFS = {
    "PERSON": {"schemata": [{"key": "email", "format": "email"}]},
    "COMPANY": {"schemata": []},
    "WORKS_AT": {"schemata": []},
}

orig = {
    "build_step_flow_graph": templates.graph._build_step_flow_graph,
    "fetch_query_package": templates.catalog.fetch_query_package,
    "fetch_query_for_compose": templates.catalog.fetch_query_for_compose,
    "get_event": templates.catalog.get_event,
    "fetch_query_rows": templates_export._fetch_query_rows,
    "export_graph_nodes": templates_export._export_graph_nodes,
    "export_relationships": templates_export._export_relationships,
    "fetch_schema_definition": templates.graph.fetch_schema_definition,
}
templates.graph._build_step_flow_graph = lambda sid: FLOW
templates.catalog.fetch_query_package = lambda qid: QUERY_PACKAGES.get(qid)
templates.catalog.fetch_query_for_compose = lambda qid: COMPOSE_KIND.get(qid)
templates.catalog.get_event = lambda eid: None
templates_export._fetch_query_rows = lambda qids: [QUERY_ROWS[q] for q in qids if q in QUERY_ROWS]
templates_export._export_graph_nodes = lambda sid, label: SCHEMA_NODES if label == "SCHEMA" else []
templates_export._export_relationships = lambda sid, roles: SCHEMA_RELS if "SCHEMA" in roles else []
templates.graph.fetch_schema_definition = lambda sid, label: SCHEMA_DEFS[label]
try:
    resolved = templates.resolve_selection("space-1", {"sequences": [SEQ1]})
finally:
    templates.graph._build_step_flow_graph = orig["build_step_flow_graph"]
    templates.catalog.fetch_query_package = orig["fetch_query_package"]
    templates.catalog.fetch_query_for_compose = orig["fetch_query_for_compose"]
    templates.catalog.get_event = orig["get_event"]
    templates_export._fetch_query_rows = orig["fetch_query_rows"]
    templates_export._export_graph_nodes = orig["export_graph_nodes"]
    templates_export._export_relationships = orig["export_relationships"]
    templates.graph.fetch_schema_definition = orig["fetch_schema_definition"]

check("resolver walks sequence steps", resolved["step_node_ids"] >= {S1, S2, S3, S4})
check("resolver follows nested sequence step", S_S2 in resolved["step_node_ids"])
check("resolver collects traversed rels", resolved["step_rel_ids"] >= {"R12", "R23", "R34"})
check("resolver pulls nested operation query", OP1 in resolved["query_ids"])
check("resolver recurses nested sequence query", SEQ2 in resolved["query_ids"])
check("resolver includes referenced schema", "PERSON" in resolved["schema_labels"])
check("resolver pulls relationship-pattern endpoint schema", "COMPANY" in resolved["schema_labels"])
check("resolver includes relationship label", "WORKS_AT" in resolved["schema_labels"])
check(
    "resolver collects regex formats (schema + param)",
    {"email", "phone"} <= resolved["regex_names"],
)
check("resolver collects code resource", "ID_res1" in resolved["resource_ids"])
check("resolver collects credential slot", "API_KEY" in resolved["credential_names"])

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("All checks passed.")
