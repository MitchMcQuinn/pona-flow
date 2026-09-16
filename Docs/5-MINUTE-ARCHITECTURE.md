# pona flow in five minutes

This is the engineer-facing skim. Setup lives in [FIRST-TIME-SETUP.md](FIRST-TIME-SETUP.md). Buyer-facing pain points live in [WHY-PONA-FLOW.md](WHY-PONA-FLOW.md).

## What it is

A **dedicated-instance runtime** where domain types, records, and workflows share one model.

Humans run a sequence from a dashboard. Agents run the *same* sequence as an MCP tool or a webhook. If a required value is missing, the run pauses (`pending` + `state_id`) instead of inventing a form system on the side.

## The problem it is built for

Typical agent stacks reconstruct context at call time: policy in a wiki, records in a CRM, routing in n8n or LangGraph, “related” facts from a vector store. Each piece works. Together they cannot see each other — so you get answers that *sound* right, and traces that are not a business reason.

Similarity is not relatedness. A workflow engine does not own your taxonomy. A graph database without an executor is still just a database.

## Shape of the model

Three node kinds. One relationship type (`POINTS_TO`). Nodes only connect to their own kind.

```
SCHEMA ──POINTS_TO──► SCHEMA     types, contracts, inheritance
INSTANCE ─POINTS_TO─► INSTANCE   records that satisfy a schema
STEP ────POINTS_TO──► STEP       executable units (a sequence is a walk)
```

A **sequence** names the STEP to start at. The executor walks outgoing edges. An edge may be unconditional or guarded on a parameter (that is how branches work). Nested / array data lives in per-entity SQLite, because that is what graphs are bad at.

Vector search exists for “what’s similar.” It is a read over opted-in INSTANCE properties stored on the Neo4j node — not the memory layer for the whole product.

## Three files to open

| File | What it is |
| ---- | ---------- |
| [`Engine/server/execution_run.py`](../Engine/server/execution_run.py) | The walk. Query / HTTP / wait / join runners. Pause when a required parameter is missing. |
| [`Engine/server/sequence_service.py`](../Engine/server/sequence_service.py) + [`mcp_gateway.py`](../Engine/server/mcp_gateway.py) | One run primitive. Dashboard, webhook, and per-space MCP tools share it. Agent keys + RBAC. |
| [`App/composer/`](../App/composer/) | Declarative packages → Cypher + SQLite. Authors don’t hand-write the dual write. |

## One tradeoff (on purpose)

Use the **graph** for relationships and routing, **SQLite** for nested data inside an entity, and **vectors** when the question is “what’s similar.”

This is the wrong tool for a warehouse, a Zapier-scale connector catalog, or an exploratory LangGraph prototype with no stable types yet. Keep those. Trigger a sequence when the next step depends on *what a record is* and *what it is linked to*.

## Stack

Python / FastAPI · Neo4j · per-space SQLite · React builder · Clerk for humans · hashed agent keys for machines · local Ollama embeddings (optional).
