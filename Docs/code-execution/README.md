# Archived: sandboxed code-execution STEPs

This folder is a parking lot for the **Code execution** custom STEP kind. It is not
wired into the running product. Saved operations, HTTP STEPs, and Local LLM STEPs
are the supported kinds.

Do not import these modules from `Engine/` or `App/` while they live here. Paths
below are relative to this folder; restore by copying them back to the same paths
under the repository root (`pona-flow/`).

## What it was

A custom STEP (`sequencial_properties.step_type === "code"`) whose script lived
outside the entity payload:

1. Builder / MCP collected `language` (`python` | `javascript`), `resource_name`,
   and `code`.
2. `persistCodeResources` upserted the script via `PUT /api/spaces/{id}/resources`.
3. The STEP entity stored only `{ "kind": "code", "resource_id": "ID_..." }`.
4. At run time the engine loaded the file and POSTed `{language, code, timeout_seconds, space_id}`
   to a separate sandbox runner (`Engine/runner`, default `127.0.0.1:8766`).
5. The runner started a disposable Docker container (`--network none`, non-root,
   memory/CPU/PID caps, 30s wall clock) and returned a JSON envelope. JSON output
   could be mapped with `response_parameters`.

The main app never executed user code in-process.

## Layout

| Path | Restore to |
|------|------------|
| `Engine/runner/` | `Engine/runner/` (sandbox service, images, `dev_runner.py`) |
| `Engine/server/resources.py` | `Engine/server/resources.py` |
| `Engine/server/routes/resources.py` | `Engine/server/routes/resources.py` |
| `Engine/schema/resources-table.sql` | `Engine/schema/resources-table.sql` |
| `App/connector/src/resources.ts` | `App/connector/src/resources.ts` |
| `App/ui/src/services/resources.ts` | `App/ui/src/services/resources.ts` |
| `tests/` | `tests/` (dedicated diagnostics) |
| `snippets/` | paste into the mixed files named in each snippet header |

Runner setup, env vars, and container flags are documented in
[`Engine/runner/README.md`](Engine/runner/README.md) (the copy in this folder).

## Restore checklist

Copy the dedicated files back, then re-apply the mixed-file logic from `snippets/`
and git history:

1. Register `resources.router` in `Engine/server/routes/__init__.py`.
2. Re-add `resources-table.sql` to `Engine/server/migrations.py` `_CATALOG_DDL_FILES`.
3. Restore `code_exec_enabled` / `runner_url` / `runner_token` in `Engine/server/config.py`.
4. Replace the `_execute_code_step` stub in `Engine/server/execution_run.py` with
   `snippets/execution_run.code_execution.py`; re-export helpers from `execution.py`.
5. Restore template resource collect/upsert (`snippets/templates_*.py`).
6. Restore `persistCodeResources`, builder Code execution UI, MCP `code_step`,
   connector resource client, and the `$param` scan of `sequencial_properties.code`.
7. Re-add `kind: "code"` / `resource_id` to `Docs/EXECUTION-package.schema.json`
   (`snippets/EXECUTION-package.kind-code.json`).
8. Point docs (`README.md` STEP kinds, `Docs/FIRST-TIME-SETUP.md`) back at the
   runner. Existing graph STEPs with `kind: "code"` and leftover catalog
   `resources` rows / on-disk `/resources/` files should still be there.

## What the product still does with leftover STEPs

Compose and graph listing still recognize `kind: "code"` so an existing node is
not rewritten into an empty HTTP STEP. Running one fails immediately with
"code-execution STEPs are not supported." Authoring and MCP refuse to create new
ones. The catalog `resources` table is no longer created on fresh installs; old
databases keep the unused table.
