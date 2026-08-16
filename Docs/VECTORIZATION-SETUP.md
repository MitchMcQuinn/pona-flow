# Local vector search — setup and test walkthrough

Hands-on guide for trying the embeddings feature after a normal local install
([FIRST-TIME-SETUP.md](FIRST-TIME-SETUP.md)). Product intent and constraints live in
[VECTORIZATION-VISION.md](VECTORIZATION-VISION.md).

You will: install Ollama → configure the space → opt a SCHEMA in → create a few
INSTANCE records → reindex → search.

---

## Prerequisites

| Need | Why |
| --- | --- |
| Working local pona flow (API + UI + Neo4j) | Same as first-time setup |
| Space you can manage | Embeddings tab is `manageSpace`-gated |
| **Neo4j Desktop 2025.01+** (or 5.18+ on leftover 5.x); local known-good: `2026.07.0` | Vector indexes |
| **Ollama** on this machine | Engine embeds via `127.0.0.1:11434` |

Confirm Neo4j is up (`bolt://127.0.0.1:7687`) and you can open the UI and create
INSTANCE records before continuing. Vector search adds nothing if the graph path
already fails.

---

## 1. Install Ollama and pull an embedding model

```bash
# macOS (Homebrew) — or download from https://ollama.com
brew install ollama
ollama serve          # leave running, or use the Ollama app
```

Pull a **dedicated embedding model** (a chat model will fail the health check):

```bash
ollama pull nomic-embed-text
ollama list           # confirm nomic-embed-text is present
```

Smoke-test the embed API:

```bash
curl -s http://127.0.0.1:11434/api/embed \
  -d '{"model":"nomic-embed-text","input":"hello"}' | head -c 200
```

You should see JSON with an `embeddings` array. If the connection is refused,
Ollama is not listening; if the body complains about the model, pull it again.

---

## 2. (Optional) Instance-wide defaults in `.env`

Per-space settings in the UI override these. If a space has never saved Embeddings
settings, it inherits the env — so naming a model here enables vector search
instance-wide without touching every space.

In the project `.env` (repo root; restart the API after edits):

```bash
PONA_FLOW_OLLAMA_URL=http://127.0.0.1:11434
PONA_FLOW_OLLAMA_EMBED_MODEL=nomic-embed-text

# How often the engine re-embeds stale records (seconds). 0 = button-only.
# Default is 300 if unset.
# PONA_FLOW_EMBEDDING_REINDEX_SECONDS=300
```

Restart:

```bash
# from repo root, venv active
python Engine/dev_server.py
```

You can skip this step and configure everything in the space UI instead.

---

## 3. Enable embeddings for a space

1. Open the UI and select (or create) a space.
2. Open **Space** settings.
3. Open the **Embeddings** tab (visible only if you can manage the space).
4. Turn **enabled** on.
5. Set:
   - **ollama url** → `http://127.0.0.1:11434` (loopback only unless you set
     `PONA_FLOW_OLLAMA_ALLOWED_HOSTS`)
   - **embedding model** → `nomic-embed-text` (exact name from `ollama list`)
6. Click **Save settings**. Saving probes the model and stores its vector width
   (shown as **vector dimensions**). A chat model or a down Ollama fails here —
   that is intentional.
7. Click **Check connection**. Expect a success line naming the URL, model, and
   dimensions.

Changing the model later drops the indexes and clears stored vectors (they are
not comparable across models). Reindex after any model change.

---

## 4. Opt a SCHEMA into vector search

Embeddings only cover types you mark. In the builder:

1. Create or update a **SCHEMA** node (e.g. `NOTE` or `CUSTOMER`).
2. Turn on **is_vectorized** above the property list.
   - First enable seeds **is_embedded** on the `is_label` property only.
3. Optionally mark other properties with **is_embedded** (notes, title, …).
   Leave ids, emails, and tax IDs off unless you really want them in the text.
4. Save / run the SCHEMA create or update so the payload persists.

For relationship types, the same toggles appear on the SCHEMA relationship cards.

---

## 5. Create a few INSTANCE records

Create several INSTANCE nodes of that type with distinct label text, for example:

| common / label property | other embedded field (optional) |
| --- | --- |
| Alice Consulting | Prefers morning calls |
| Bob Manufacturing | Warehouse on the east side |
| Carol Design Studio | Focuses on brand systems |

You need enough variety that a similarity query can prefer one over the others.
A single record only proves that reindex wrote a vector.

Writes do **not** embed inline in v1. New records have no `embedding` yet; updates
to an already-indexed type set `embedding_stale`. Either way, reindex (or the
periodic sweep) fills them in.

---

## 6. Reindex the space

Back in **Space → Embeddings**:

1. Click **Reindex space**.
2. Wait for the summary (e.g. `N vectorized types: X embedded of Y scanned`).

Notes:

- Only **is_vectorized** SCHEMAs are walked.
- Empty embed text is skipped; Ollama failures stamp `embedding_stale` and may
  abort after consecutive failures.
- Large labels stop at a per-run cap; run again if you hit it.

Optional: reindex one label via API (with your session cookie / auth as usual):

```bash
curl -s -X POST "http://127.0.0.1:8765/api/spaces/<SPACE_ID>/embeddings/reindex" \
  -H "Content-Type: application/json" \
  -d '{"attributive_label":"NOTE","kind":"node"}'
```

Omit `attributive_label` to reindex the whole space (same as the button).

---

## 7. Search

Two ways in: the QUERY builder, or the search API directly.

### 7a. From the QUERY builder (recommended)

1. Operation **read**, label **INSTANCE**.
2. Pick your vectorized type in the `attributive_label` dropdown.
3. In the **Vector search** section, flip `vector_search` on.
4. Enter **Search text** and **k**, then click **Run**. (Either field also accepts a
   `$parameter` so a sequence can supply it — see *Naming the inputs yourself* below.)

Results land in the usual results panel with both graph and table views; the table
gains a `score` column, best-first.

**Searching every type.** The `:INSTANCE` vector index already spans every vectorized
type, so **Search all types** (off by default) simply drops the label filter — the
dropdown selection is then ignored and hits can come back as a mix of types. Two
consequences worth knowing:

- With no label filter, an ordinary per-node WHERE (say `STATUS = 'active'`) applies to
  every type, and records that lack the property just drop out.
- The composed Cypher names no SCHEMA, so a broad search is *not* reported as a
  reference to any one type. Deleting a SCHEMA will not warn you about it, and a
  template export will not pull a SCHEMA in on its behalf. That is correct — the
  operation genuinely isn't bound to a type — but it means a broad search is invisible
  to those safety nets.

While the toggle is on the builder hides the controls vector search overrides —
RETURN projections, DISTINCT, ORDER BY, SKIP/LIMIT — and blocks adding a hop.
Per-node WHERE filters stay available and apply *after* the index returns its
candidates, so a tight filter can return fewer than `k` rows even when more matching
records exist. Widen the filter or raise `k` if that bites.

Requirements the builder hints at rather than failing on: the space must have
embeddings enabled, and the selected SCHEMA must be `is_vectorized`. The
`attributive_label` must be a concrete label, not a `$parameter`.

**Saving and sequences.** A vector-search read saves as an ordinary operation and
runs inside a sequence. Two parameters are declared on the catalog row, so a step can
override either at run time:

| Parameter | Type | Purpose |
| --- | --- | --- |
| `vector_query_text` | string | The search text. Wire it from an upstream step to search for something computed at run time. |
| `vector_k` | integer | Nearest neighbours to return (1–100). |

The embedding itself (`vector_query`), the index name, and the overfetch are filled
by the engine at execution time and are never sent by the client.

**Naming the inputs yourself.** Instead of a literal, type exactly `$searchTerm` in
**Search text** or `$topK` in **k** and that becomes an ordinary declared parameter,
named by you and populated by the sequence step like any other. Worth doing for two
reasons: the run panel shows a name that means something, and two vector searches in
one sequence stop colliding — with the reserved names they would both read the same
`vector_query_text`.

The field has to be *exactly* the reference (`$searchTerm`, not `find $searchTerm`),
since the value is substituted whole rather than interpolated into a string. Once
either field is parameterized the builder's **Run** button goes away, as it does for
any query with parameters: there is no value to run with until a sequence supplies
one. Save it and drive it from a sequence instead. A parameterized `k` also can't be
range-checked while you author it, so an out-of-range value surfaces as a run-time
error rather than a builder hint.

### 7b. From the API

```bash
curl -s -X POST "http://127.0.0.1:8765/api/spaces/<SPACE_ID>/embeddings/search" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "design brand studio",
    "attributive_label": "NOTE",
    "k": 5,
    "kind": "node"
  }'
```

Expect `hits` with `id`, `attributive_label`, `display_label`, and `score`,
ordered best-first. Prefer always sending `attributive_label`: the shared
`:INSTANCE` index mixes every vectorized type. This route is also the only way to
search relationship vectors (`"kind": "relationship"`), which the builder toggle
does not cover.

If Ollama is down, search returns **503** (writes can degrade to stale; search
cannot). A builder run fails the same way.

Auth: same as other `/api/*` routes (Clerk session, or local bypass with
`PONA_FLOW_DISABLE_AUTH` / `VITE_DISABLE_AUTH`). You need `read:INSTANCE` on the
space; reindex / config save need space manage.

---

## 8. Confirm staleness behavior (optional)

| Action | Expected |
| --- | --- |
| Update an INSTANCE’s embedded property | Graph write succeeds; record marked stale; next reindex / sweep refreshes the vector |
| Change SCHEMA `is_embedded` / `is_vectorized` | Matching stored vectors marked stale |
| Rename a node’s `is_label` value | That node’s INSTANCE `POINTS_TO` edge vectors marked stale (relationship text includes endpoint labels) |
| Change embedding model in Embeddings settings | Indexes dropped/recreated; stored vectors cleared; reindex required |
| Disable embeddings | Indexes dropped; `embedding` removed; SCHEMA flags kept |

Staleness marking after an INSTANCE update is **label-scoped** (every record of
that type with a vector), not per touched id. Fine for a smoke test; on large
types prefer waiting for the periodic sweep or a deliberate reindex rather than
updating in a tight loop.

Periodic sweep: `PONA_FLOW_EMBEDDING_REINDEX_SECONDS` (default 300). Set `0` to
rely only on the Reindex button while debugging.

---

## 9. Quick failure checklist

| Symptom | Likely cause |
| --- | --- |
| Save settings / Check connection fails | Ollama not running; wrong URL; model not pulled; chat model instead of embed model |
| Reindex: “not enabled” / “no embedding model” | Embeddings tab not saved enabled, or model blank |
| Reindex: SCHEMA “is not vectorized” | Forgot `is_vectorized` on that type |
| Reindex embedded = 0 | No INSTANCE rows, or no embeddable text (empty label / no `is_embedded`) |
| Search 503 | Ollama down or model missing at query time |
| Search hits empty / wrong types | Forgot `attributive_label`, or never reindexed after create |
| Builder run returns fewer than k rows | A per-node WHERE filter is post-filtering the overfetched candidates; widen it or raise k |
| Vector search toggle runs but warns | Space embeddings disabled, or the SCHEMA is not `is_vectorized` |
| Run button gone after typing `$searchTerm` | Expected: a parameterized text or k has no value until a sequence supplies one. Save the operation and run it from a sequence |
| `$searchTerm is required for vector search` at run time | The sequence step left that parameter blank |
| Embeddings tab missing | Principal cannot manage the space |
| Index / Cypher errors on vector DDL | Neo4j too old for vector indexes |

---

## 10. Suggested minimum happy path

1. `ollama pull nomic-embed-text` and leave `ollama serve` running.
2. Enable Embeddings on a space → **Check connection** → green.
3. SCHEMA with `is_vectorized` + label property embedded → save.
4. Create 3 INSTANCE records with distinct labels → **Reindex space**.
5. Read INSTANCE in the builder → flip `vector_search` on → text that matches one
   record → **Run** → that record ranks first in the graph and table views.

When that works, the feature loop is good. Sequences that need “find similar,
then traverse” save the vector-search read as an operation and run an ordinary
`MATCH` in the next step.
