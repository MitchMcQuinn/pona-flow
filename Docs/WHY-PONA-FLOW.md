# Why pona flow

pona flow is the workspace where **what things mean**, **the records themselves**, and
**the work that acts on them** live in one place — so people and AI agents decide from
the same connected context, and you can show the path they took.

The technical description is accurate: a dedicated-instance runtime for graph-based
context engineering. This document is the buyer-facing version. It names the pains that
description is solving, and how pona flow compares to the tools teams usually stitch
together instead.

If you want the deep *why a graph* argument, read
[CONTEXT-GRAPH-DECISIONING.md](CONTEXT-GRAPH-DECISIONING.md). If you want to open the
product, start at [GETTING-STARTED.md](GETTING-STARTED.md).

---

## The situation most teams are in

A typical "AI-ready" stack looks like this:

| Layer | What it holds | What it cannot see |
| ----- | ------------- | ------------------ |
| Wiki / Notion / Confluence | Policy, in prose | Whether a *record* is governed by that policy |
| CRM / CMS / spreadsheets | Records | The *rules* those records inherit |
| Zapier / n8n / Make | Triggers and integrations | Domain meaning — a field is just a field |
| Vector DB + RAG | Text that *sounds like* the question | What is *connected* to the matter at hand |
| LangGraph / custom agents | Orchestration in code | An inspectable model operators can edit |
| Hand-written MCP servers | Tools as Python functions | The same artifacts the rest of the org uses |

Each piece is good at its job. Together they force a reconstruction at runtime: the
agent guesses context, the workflow guesses rules, and the system of record is unaware
either one ran. When something goes wrong, the outcome is in one tool and the rationale
is in another — or gone.

pona flow collapses that reconstruction. A **schema** is the contract and the taxonomy.
An **instance** is a record that satisfies it. A **sequence** is the work that reads,
writes, calls out, waits, and branches. Humans run sequences from a dashboard. Agents
run the *same* sequences as MCP tools or webhooks. Authoring and execution share one
model.

---

## Pain points pona flow is built for

Each section is a problem you can recognize without knowing the product, then the
usual workaround, then what changes if the context is a graph you can run.

### 1. Agents retrieve lookalikes, not related facts

**What it feels like.** A support agent answers from tickets that *sound like* this
one, and misses the linked account, plan, and policy. A research assistant dumps
semantically similar notes into the prompt and still cannot say which ones bear on the
decision. Similarity is treated as relevance.

**What people try.** A vector database plus RAG; sometimes GraphRAG on chunked
documents. Fine-tuning the chunker, the top-k, the reranker.

**Why that stays painful.** Embeddings answer "what text is nearby in meaning." They
cannot follow a defined link, inherit a rule from a type, or tell you *why* a record
was included. A hard contraindication, a sanctions flag, or a parent account that uses
different vocabulary is invisible.

**What pona flow does.** "Pertinent" is a neighborhood. Traversal from the subject
pulls the connected records *and* the schema rules they obey — a bounded, explainable
context window. Vector search still exists for "what's similar"; it is not asked to
stand in for "what's connected."

### 2. Business rules live in three places, and none of them agree

**What it feels like.** Policy is in a wiki. Routing is in a workflow tool. Validation
is in application code. A contractor is both a person and a vendor, and the matrix of
rules is maintained by whoever last touched the spreadsheet. Changing "interviews need
legal review" means hunting through templates, flags, and deploys.

**What people try.** BPM suites with decision tables; CMS taxonomies with tag
combinations; `if/else` in the app; copy-pasted frontmatter.

**Why that stays painful.** Real domains are *heterarchical* — one thing belongs under
several parents. Relational schemas encode one rigid tree. Documents copy the category
path into every record, so reclassifying means rewriting many documents. The
classification decision and the workflow it should trigger live in different systems.

**What pona flow does.** Schema nodes form the ontology. Instances point at the types
that govern them. Rules attach to types, not to thousands of records. A new policy is
an edge, not a migration. Walk up from the record and you get the union of inherited
rules — including multiple parents — and the sequence that should run because of them.

### 3. Changing a branch means a deploy

**What it feels like.** Approve vs. escalate, premium vs. standard, retry vs. give up
— the routing is in Python, in a Zapier's filter stack, or in a Temporal workflow
definition. Operators cannot see it. Engineers cannot change it without a release.

**What people try.** n8n/Make for "no-code" branches; LangGraph for agent graphs;
Camunda for BPMN. All of these can draw a flow. None of them put the flow *next to*
the data and rules it is deciding over.

**Why that stays painful.** The workflow engine does not know your taxonomy. The CRM
does not know which step ran. The agent framework knows the prompt. You still have
three sources of truth for "what happens next."

**What pona flow does.** The workflow *is* a graph of steps joined by guarded edges.
Two sibling edges branch on a parameter. Changing the rule is editing an edge
condition. The same graph is what the dashboard visualizes, what the executor walks,
and what an auditor replays.

### 4. "Why did we decide that?" is unanswerable

**What it feels like.** A claim was escalated, a vendor was rejected, an agent called
the wrong tool. You have the outcome. You do not have the route. Regulators, customers,
and your own operators all ask the same question.

**What people try.** Log aggregation, LangSmith-style traces, "the model said so,"
reconstructing joins after the fact.

**Why that stays painful.** If logic lived in code, it is gone when the function
returns. If retrieval was a similarity score, the rationale is a number. Tables store
the result row, not the path that produced it.

**What pona flow does.** The path through the graph *is* the explanation. The run
records which steps executed; each branch is the edge whose condition matched. "We
required enhanced due diligence because `Wire Transfer` → `High-Value` →
`Requires-EDD`" is inspectable structure, not a reconstructed story.

### 5. Human-in-the-loop is bolted on

**What it feels like.** Fully autonomous agents act without a checkpoint you can
trust. Fully manual processes never scale. Most frameworks either dump every decision
on the LLM or require custom form plumbing for every pause.

**What people try.** Approval nodes in Zapier; `interrupt()` in LangGraph; a Slack bot
that someone has to watch; a second system for "tasks."

**Why that stays painful.** The pause is a special case, not the same run. Resume
state, required parameters, and permissions are reinvented per integration. Agents and
humans do not share a contract.

**What pona flow does.** Required parameters pause the run as `pending` and return
exactly what is still needed, plus a `state_id` to resume. The same contract is used
by the dashboard, the sequence webhook, and the MCP gateway. Background waits (timers,
events, retries) are a different status — `waiting` — so callers do not treat a clock
as a form. Loops can pause mid-iteration and continue on the same pass.

### 6. Every new agent capability is another server to write

**What it feels like.** Product wants the agent to "qualify a vendor" or "assemble
publishing context." Engineering writes a new MCP tool, a new prompt, a new auth
story. The tool is code. Operators cannot open it. The next capability is the same
tax.

**What people try.** A growing folder of FastMCP handlers; one mega-server with a
kitchen-sink tool list; wrapping n8n webhooks as tools and hoping the agent guesses
the payload.

**Why that stays painful.** Tools and workflows diverge. Something built for Claude
cannot be edited in the visual builder. Something built in the builder is not
automatically a tool. RBAC is a second implementation.

**What pona flow does.** A space *is* an MCP server. Its tools *are* its sequences.
Author a sequence in the builder (or via the authoring MCP) and it is callable by
Claude, an IDE agent, or an HTTP client with the same agent key and the same
permission allowlist. There is a second MCP surface for *creating* schemas, steps, and
sequences — so agents can configure the engine, not only run it, and everything they
build reopens in the visual builder.

### 7. Eligibility, impact, and ownership take a week of SQL

**What it feels like.** "Is this customer eligible?" "If we deprecate this component,
what breaks?" "Who ultimately owns this account?" The answer is a chain of unknown
length. Someone writes a recursive CTE, or exports to a spreadsheet, or says they
will get back to you.

**What people try.** Deeper JOINs, recursive SQL, a one-off Neo4j spike with no
runtime around it, asking the LLM to "reason" over a dump of tables.

**Why that stays painful.** Path length is not known when you write the query.
Document stores duplicate the chain and drift. An LLM will not reliably walk a
nine-hop ownership path.

**What pona flow does.** Reachability is a first-class read. Downstream and network
traversals return the connected subgraph regardless of depth. The decision
(eligible, impacted, owned-by) is a question about paths, which is what the model
stores.

### 8. The stack is shared, but the context is not yours

**What it feels like.** Agent memory, embeddings, and workflow state sit in
multi-tenant SaaS. Legal, security, or a large customer asks where the working
context lives. The honest answer is "in several vendors, reconstructed at call
time."

**What people try.** VPC private links, "zero retention" checkboxes, running LangGraph
on your own cluster and still pushing vectors to a hosted index.

**Why that stays painful.** Ownership is a property of the *model*, not of the
network path. If context is scattered, "it's in our VPC" does not make it one
inspectable workspace.

**What pona flow does.** Each customer gets a **private instance**. Spaces isolate
projects or clients inside it. Graph, per-space SQLite, catalog, and run state stay
on that instance. Agents authenticate with scoped keys. Data is not pooled with
other customers.

---

## How it compares

Comparisons are by *job to be done*, not by feature checklist. Several of these tools
are the right choice for a different job; the point is what breaks when you ask them
to be the system of context.

### Workflow automation (Zapier, Make, n8n)

**They excel at** connecting hundreds of SaaS APIs, firing on a trigger, moving
payloads from A to B with little engineering.

**They struggle when** the next step depends on what kind of thing a record *is*,
on a chain of relationships, or on a policy that should be inherited rather than
copied into the zap. The workflow does not own the ontology. Branching is filters
on a JSON blob. Explainability is an execution log of HTTP calls.

**Choose pona flow when** the automation *is* the decision, and the decision needs
the graph of types, records, and prior steps — not only the last webhook body.
Keep n8n (or similar) when you need broad connector coverage; an inbound
[external event](EXTERNAL-EVENTS.md) can start a pona flow sequence from those
tools.

### Agent frameworks (LangChain, LangGraph, CrewAI)

**They excel at** arbitrary Python control flow around models: custom tools, cyclic
graphs of LLM calls, research prototypes.

**They struggle when** operators need to see and edit the plan, when the same
workflow must be a dashboard button *and* an MCP tool, and when context is more
than a prompt plus retrieved chunks. The graph is code. Changing it is a deploy.
Human-in-the-loop and permissions are yours to invent.

**Choose pona flow when** the agent should act inside a durable, inspectable domain
model that non-engineers can open. Keep a framework when you are still exploring
the *shape* of an agent and do not yet have types, records, and rules worth
storing.

### RAG and vector databases (Pinecone, Weaviate, pgvector, GraphRAG)

**They excel at** "find text like this" over large unstructured corpora.

**They struggle when** relatedness is structural: the linked account, the inherited
policy, the contraindication that uses different words. GraphRAG on documents
improves retrieval; it does not give you a runnable workflow, a schema contract,
or a pause-and-resume HITL run.

**Choose pona flow when** you need related *and* similar. pona flow embeds opted-in
instance properties into Neo4j itself — a hit *is* the record, not a sidecar
chunk — and still treats vector search as one kind of read, not the memory layer
for the whole product.

### Durable execution (Temporal, Cadence, Airflow)

**They excel at** long-running jobs, retries, worker fleets, and "never lose this
saga" at infrastructure scale.

**They struggle when** the unit of work is a *domain decision* rather than a job:
taxonomy, record neighborhood, agent-callable tools, a visual builder that writes
the same artifact the worker runs. You will still build the context model on the
side.

**Choose pona flow when** the durable thing is context plus a sequence of domain
steps (including waits and joins), not a fleet of activity workers. Choose
Temporal when you are orchestrating large-scale backend jobs and already have a
system of record.

### BPM / case management (Camunda, Flowable, ServiceNow)

**They excel at** BPMN compliance, process mining, and enterprise case queues.

**They struggle when** the process must also be the ontology and the agent tool
surface. BPMN is a process drawing; it is not a heterarchical schema graph, and it
is not MCP. Agents become another integration.

**Choose pona flow when** you want one model for classification, records, and
routing, callable by agents without a second BPM-to-AI translation layer. Choose a
BPM suite when the organization is already standardized on BPMN and process
mining, and AI is a side channel.

### A graph database by itself (Neo4j, Neptune, and Cypher in the app)

**They excel at** storing and querying relationships. pona flow is built on that
strength.

**They struggle when** you still have to invent the execution engine, parameter
pause/resume, RBAC for runs, MCP exposure, a composer that non-experts can use,
SQLite payloads for nested data, and a builder whose saves reopen later. A graph
without that runtime is a database, not a workspace.

**Choose pona flow when** the graph is the *working environment* — schemas,
instances, and sequences — not only a query backend. Use Neo4j directly for
analytics and ad-hoc Cypher that the product does not need to author or run as a
sequence.

### Vertical SaaS (Salesforce, Contentful, Notion, Linear)

**They excel at** being a finished CRM, CMS, or knowledge base with opinions and
ecosystems.

**They struggle when** your domain does not fit their objects, when agents need a
first-class tool surface over *your* types, or when you need the same engine for
CRM-like, CMS-like, and decision-support work without buying four platforms.

**Choose pona flow when** the point is a private workspace you shape (CMS, CRM,
agency/project management, personal/institutional knowledge, decision support)
rather than adopting a vendor's object model. Keep vertical SaaS when the
packaged process *is* the product you want.

### Hand-rolled MCP servers

**They excel at** wrapping one existing API quickly.

**They struggle when** the tool list *is* the business. Each new sequence is code.
Humans and agents do not share an editor. Authz is duplicated.

**Choose pona flow when** tools should appear because someone (or an authoring
agent) saved a sequence, not because someone shipped a handler.

---

## At a glance


| Need | Typical alternative | Where that alternative stops | What pona flow treats as native |
| ---- | ------------------- | ---------------------------- | ------------------------------- |
| Relevant context for an agent | RAG / vector DB | Similarity ≠ relatedness | Neighborhood traversal + optional vectors |
| "What kind of thing is this?" | Tags, tables, wikis | Heterarchy and inheritance are awkward | Schema graph; rules on types |
| Branching work | n8n, LangGraph, BPMN | Flow is disconnected from domain data | Guarded `POINTS_TO` edges on steps |
| Pause for a human | Custom forms / Slack | Special-case resume | First-class `pending` + `state_id` |
| Agent-callable tools | Hand-written MCP | Tools are code | Sequences *are* the tools |
| Agents that *build* workflows | Prompt-to-YAML | Artifacts humans cannot reopen | Authoring MCP writes the same builder snapshot |
| Why a decision fired | Traces and logs | Outcome without route | The executed path is the rationale |
| New relationship type | Schema migration | Slow evolution | New edge; traversals pick it up |
| Long-running waits / loops | Temporal, cron | No domain model | Wait/join steps, loop types, resumable state |
| Data ownership | Multi-tenant SaaS | Context scattered across vendors | Dedicated instance, space-scoped keys |


---

## When pona flow is the wrong tool

Honesty is part of the pitch.

- **Bulk aggregates** ("sum revenue by month") belong in SQL. pona flow keeps nested
  payloads in SQLite for that class of question; it does not replace a warehouse.
- **Pure semantic search over a huge unstructured corpus** belongs in a vector
  store. Use pona flow's embeddings for opted-in *records*, not as a generic
  document index.
- **Hundreds of SaaS connectors with no domain model** belong in an iPaaS. Trigger
  pona flow from those tools; do not expect pona flow to be Zapier's connector
  catalog.
- **Exploratory agent prototypes with no stable types yet** are cheaper in a
  notebook or LangGraph. Adopt pona flow when the types, records, and rules are
  worth keeping.

The design rule: **use the graph for relationships and routing, SQLite for nested
data inside an entity, and vectors when the question is "what's similar."** pona
flow's value is making the first two work together — and making the result runnable
by people and agents — so decisions can be both connected and detailed.

---

## What this looks like in the product

You work in a **space** (a project, client, or department). You define **schemas**
(the shape and taxonomy of information), create **instances** (the records), and
save **sequences** (the work). A sequence can read or write the graph, call an
external HTTP API, wait for a time or an event, join parallel arms, loop with an
exit condition, or pause for a person.

Those sequences are one list in the UI. They are also:

- `POST /api/spaces/{space_id}/sequences/{sequence_id}/run` — see
  [SEQUENCE-WEBHOOKS.md](SEQUENCE-WEBHOOKS.md)
- MCP tools at `/api/spaces/{space_id}/mcp` — see [MCP-GATEWAY.md](MCP-GATEWAY.md)
- Targets of inbound external events — see [EXTERNAL-EVENTS.md](EXTERNAL-EVENTS.md)

A companion authoring MCP lets an IDE agent *create* the schemas and sequences,
through the same validation the visual builder uses —
[MCP-AUTHORING.md](MCP-AUTHORING.md).

---

## Who this is for

- Teams whose agents need **related, governed context**, not only retrieved prose
- Operators who need to **change a rule without a deploy**
- Organizations that must **show the path** of a decision, not only the outcome
- Builders who want **one artifact** that is a dashboard workflow, a webhook, and
  an agent tool
- Anyone evaluating a private workspace for CMS-, CRM-, knowledge-, or
  decision-support-shaped work, without buying a different platform for each

If that is you, the technical description — a runtime engine and workspace for
context engineering — is the implementation. This document is the reason it exists.
