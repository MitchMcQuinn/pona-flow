# Decisioning with Context Graphs

Why does pona flow model context as a graph instead of a pile of tables, documents,
or vectors? Because the hard part of automating decisions is rarely *storing* a fact —
it is **relating** facts to each other and then **acting** on those relationships. This
document describes the categories of *decisioning problems* where a context graph
(pona flow's blended Neo4j + SQLite model) consistently beats non-graph approaches,
with concrete examples drawn from the product's own model.

> **The pona flow model in one paragraph.** Everything is one of three node types —
> `STEP` (sequential: conditional, branching, looping operations), `SCHEMA`
> (schematic: taxonomies and ontologies), and `INSTANCE` (spatial: the actual data
> records) — and nodes connect only to others of their own type through a single
> `POINTS_TO` relationship. The graph carries the *relationships*; per-entity SQLite
> payloads carry the *nested/array data* the graph is bad at querying. A small
> execution engine walks `STEP` chains, branching on parameters, pausing for human
> input, and passing values between steps. "Decisioning" here means both **answering a
> question from related context** and **routing a workflow based on that context**.

---

## How to read the examples

Each section below follows the same shape:

- **The decisioning problem** — the question or routing choice that has to be made.
- **Why non-graph solutions struggle** — relational tables, flat JSON/documents, or
  vector stores.
- **The context-graph approach** — how pona flow's `STEP`/`SCHEMA`/`INSTANCE` +
  `POINTS_TO` model expresses it directly.

A quick decoder for the comparison points:

| Non-graph approach | What it is | Where it hurts for decisioning |
|--------------------|-----------|--------------------------------|
| **Relational tables** | Rows + foreign keys + JOINs | Relationship depth is unknown at query time; recursion is awkward and slow |
| **Document store / flat JSON** | Nested blobs keyed by id | Cross-entity relationships get duplicated or denormalized; no traversal |
| **Vector store / embeddings** | Similarity over text chunks | Great at "what's *similar*", blind to "what's *connected* and by what rule" |
| **Hardcoded app logic** | `if/else` and state in code | The decision logic is invisible to the data layer; not inspectable or reusable |

---

## Decisions a context graph is particularly equipped to make

The sections below go deep on *why* graphs win. This list is the quick inventory: the
kinds of **yes/no, which-one, or what-set** decisions that fall out naturally when
relationships are first-class data. Each item is phrased as the decision itself; the
section numbers point to where it is explained in detail.

### Reachability and impact

- **Is A connected to B (directly or indirectly)?** — eligibility, access, or influence
  that depends on a chain of links, not a single field. *(§1)*
- **What is the full downstream impact of changing or removing X?** — blast-radius and
  dependency analysis. *(§1)*
- **Who is the ultimate owner or authority for this entity?** — walk the delegation or
  reporting chain to the root. *(§1)*
- **Which records are in scope for this matter?** — the connected neighborhood around a
  case, account, or project. *(§1, §4)*

### Routing and process control

- **Which step should run next?** — follow the `STEP` edge whose guard condition matches
  the current parameters. *(§2)*
- **Approve, reject, escalate, or retry?** — branch on a runtime value without
  hardcoded workflow code. *(§2)*
- **Should this run pause for human input?** — the executor stops when a required
  parameter can only come from a person. *(§7)*
- **When should a loop exit?** — take the back-edge until an exit condition on a sibling
  edge is satisfied. *(§7)*

### Classification, policy, and rules

- **What kind of thing is this, and what rules apply?** — classify by `SCHEMA`
  ancestors and inherit constraints from the taxonomy. *(§3)*
- **Does this record satisfy the schema for its type?** — validation is tied to the
  schema node the instance points to. *(§3)*
- **Which policies apply when an entity has multiple parents?** — gather rules from every
  reachable schema ancestor (heterarchy). *(§3)*
- **Has the governing rule set changed since this was last evaluated?** — compare the
  current schema subgraph to what was in effect at decision time. *(§3, §5)*

### Context and relevance

- **What context should we show before deciding?** — assemble the bounded subgraph
  linked to the subject, not the whole database. *(§4)*
- **Which related records must an agent see to answer safely?** — traverse `INSTANCE` and
  `SCHEMA` links to build an explainable context window. *(§4)*
- **Is this record relevant to the current task, or merely similar?** — structural
  relatedness (linked) vs. semantic similarity (lookalike). *(§4)*

### Structure, dependencies, and risk

- **Are there circular dependencies that block progress?** — detect cycles in the task or
  component graph before committing. *(§7, §8)*
- **What is the critical path through this network?** — longest or bottleneck path
  through connected `STEP` or `INSTANCE` nodes. *(§1, §8)*
- **Does this subgraph match a known risky pattern?** — fraud rings, mutual referral
  loops, diamond dependencies. *(§8)*
- **Who else is affected by the same upstream failure?** — shared-ancestor or
  shared-dependency grouping. *(§1, §8)*

### Provenance and accountability

- **Why was this outcome reached?** — replay the path of steps and edges the run
  followed. *(§5)*
- **Which rule or condition actually fired?** — the matching edge condition is the
  rationale. *(§5)*
- **What was the state of the graph when the decision was made?** — audit against the
  traversed subgraph, not just the final row. *(§5)*

### Evolution and discovery

- **Can we start using a new relationship type immediately?** — add a `POINTS_TO` edge
  and include it in the next traversal; no migration required. *(§6)*
- **What new decisions become possible once this link exists?** — every new edge
  potentially unlocks reachability, routing, and pattern questions. *(§6)*
- **Who or what should we connect next?** — find isolated nodes, weak bridges, or
  missing links in the network. *(§6, §8)*

### A simple test

If answering the decision requires **walking links** (of unknown depth), **matching a
connection pattern**, **routing through guarded transitions**, or **inheriting rules from
a taxonomy**, a context graph is the natural home for it. If it is purely **summing
columns**, **filtering on one record's attributes**, or **finding text that sounds
like something else**, reach for SQL or vectors instead — see
[When a context graph is *not* the better tool](#when-a-context-graph-is-not-the-better-tool).

---

## 1. Decisions that depend on *chains* of relationships (multi-hop reasoning)

**The decisioning problem.** "Is this customer eligible?" / "What is downstream of this
change?" / "Who ultimately owns this account?" The answer depends not on one record but
on a *path* of unknown length: A relates to B relates to C, and the decision falls out
of the whole chain.

**Why non-graph solutions struggle.** In relational tables, a path of unknown depth
becomes a self-join you cannot write in advance — you don't know whether it is 2 hops or
9. Recursive CTEs exist but get slow and unreadable, and every new question is a new
hand-tuned query. Document stores force you to duplicate the chain into each blob and
keep the copies in sync. Vector search can find *similar* records but cannot follow a
*defined* link.

**The context-graph approach.** Reachability is a first-class operation. pona flow's
read queries can emit a variable-length traversal directly — the `read_traversal` mode
produces a `-[*]->` (downstream) or `-[*]-` (network) path from a single node and
returns the whole subgraph:

```247:248:App/composer/src/types.ts
  read_traversal?: "downstream" | "network";
```

- **CRM example:** "Show every contact, deal, and task reachable from *Acme Corp*."
  One traversal from the `Acme Corp` `INSTANCE` returns the neighborhood regardless of
  how deep it goes — no pre-declared join depth.
- **DSS / impact analysis example:** "If we deprecate this component, what breaks?"
  Walk `POINTS_TO` downstream and the affected set *is* the result.

The decision ("eligible", "impacted", "owned-by") becomes a question about
**reachability and paths**, which graphs answer natively and tables answer painfully.

---

## 2. Branching and conditional *workflow* decisions (routing)

**The decisioning problem.** A process must take different paths based on runtime
values: approve vs. reject, retry vs. escalate, premium vs. standard handling. The
decision isn't a stored fact — it's *which way the work flows next*.

**Why non-graph solutions struggle.** This logic usually ends up hardcoded in
application code or buried in sprawling `CASE` statements. The routing rules live far
from the data, can't be inspected or edited by non-engineers, and every new branch is a
code change and a deploy.

**The context-graph approach.** The workflow *is* a graph of `STEP` nodes joined by
`POINTS_TO` edges, and each edge can carry a guard condition. Two sibling edges can
branch on a single parameter — one fires when it is true, the other when it is false —
using `condition_expected`:

```119:124:App/composer/src/types.ts
  // For a `parameter` condition: the boolean result the gating parameter must
  // coerce to for this transition to fire ("true"/"1" -> true; else false).
  // Lets two sibling relationships branch on a single parameter (one for the
  // true path, one for the false path). Defaults to true when omitted.
  condition_expected?: boolean;
```

The executor evaluates those guards as it walks the chain, following only the edges
whose condition matches:

```820:829:Engine/server/execution.py
            expected = transition.get("condition_expected")
            if isinstance(expected, bool):
                # Branch on the parameter's strict boolean value: this transition
                # fires only when it matches the expected result, letting a sibling
                # relationship take the opposite branch.
                if _coerce_bool(value) == expected:
                    queue.append(target)
            elif _truthy(value):
                # Legacy gating (no expected result configured): follow when truthy.
                queue.append(target)
```

- **AMS example:** An approval workflow where `amount_over_threshold` routes to either a
  "manager sign-off" `STEP` or an "auto-approve" `STEP`. Changing the rule is editing an
  edge condition, not redeploying code.
- **Agentic example:** An agent's tool-use plan where the result of one call decides the
  next. The branch logic is data the agent (or a human) can read and reason about.

The routing decision lives **in the graph next to the steps it routes**, so it is
visible, editable, and reusable instead of trapped in code.

---

## 3. Classification and inheritance decisions (taxonomy / ontology)

**The decisioning problem.** "What *kind* of thing is this, and therefore what rules
apply?" A `Refund` is a kind of `Transaction`, which is a kind of `Ledger Event`; a
decision about refunds may need to inherit policy from any ancestor. Real domains are
also *heterarchical* — one thing legitimately belongs under several parents (a "Contractor"
is both a "Person" and a "Vendor").

**Why non-graph solutions struggle.** Relational schemas encode one rigid hierarchy
(table-per-type or a `parent_id` column) and choke on multiple inheritance. Adding a new
classification or a second parent is a migration. Document stores copy the category path
into each record, so reclassifying means rewriting many documents.

**The context-graph approach.** `SCHEMA` nodes form the taxonomy/ontology via
`POINTS_TO`, and a node can point to (or be reached from) more than one parent —
expressing heterarchy without schema migrations. Classification becomes "what `SCHEMA`
nodes is this reachable from?", and inherited rules are gathered by walking *up* the
schema graph. Because `SCHEMA` defines the shape that `INSTANCE` rows must follow,
the classification decision and the validation rules it implies live in one place.

- **CMS example:** A content taxonomy where an "Interview" is both "Editorial" and
  "Video". Publishing rules attached to either ancestor apply, found by traversal rather
  than copied onto every article.
- **DSS example:** Policy inheritance — "which compliance rules apply to this account
  type?" is answered by the schema ancestors it points to, and a new rule is a new
  `POINTS_TO` edge, not a migration.

For six full domain walkthroughs (healthcare, finance, CMS, procurement, IT ops, legal)
with side-by-side comparisons to relational, document, and vector approaches, see
[Ontology examples](#ontology-examples-how-schema-context-beats-other-methods) below.

---

## Ontology examples: how SCHEMA context beats other methods

An **ontology** here is a network of `SCHEMA` nodes — types, categories, and the rules
attached to them — linked by `POINTS_TO`. An `INSTANCE` (a real record) points to the
schema(s) that govern it. When a decision has to be made *about* that record, the
ontology is the **context**: not just "what are the field values?" but "what *kind* of
thing is this, what rules does that kind inherit, and what else in the domain is
defined in relation to it?"

The examples below are real domain ontologies expressed in pona flow terms. Each one
shows the same decision answered three ways — relational tables, flat documents, and
ontology-as-context — so the difference is concrete.

### Example 1 — Clinical treatment eligibility (healthcare)

**The ontology.**

```text
(Patient)          (Condition)         (Treatment)
    │                  │                    │
    └── INSTANCE ──► Diabetes ──► Insulin Therapy
                       │                    │
                       └──► Contraindicated ◄── (if active heart failure)
```

`SCHEMA` nodes carry constraints: `Insulin Therapy` requires `blood_glucose` (number,
required); `Contraindicated` when linked to `Heart Failure` (boolean flag on the
relationship payload).

**The decision.** *Should we prescribe insulin for this patient?*

| Approach | What context it provides | Why it falls short |
|----------|-------------------------|-------------------|
| **Relational tables** | `patients`, `diagnoses`, `medications`, `contraindications` joined on foreign keys | You must know every table to join upfront. A new contraindication type means a new table or column. "Is heart failure contraindicated for insulin?" is buried in a join path, not visible as domain knowledge. |
| **Document / EHR blob** | A patient summary JSON with nested conditions and meds | Rules are copied into the document or live in application code. If the contraindication policy changes, every stale summary is wrong until regenerated. No shared definition of "what insulin therapy *means*." |
| **Vector search** | Chunks of similar case notes ("patients like this received metformin") | Finds *similar narratives*, not *defined clinical relationships*. May miss a hard contraindication that uses different vocabulary. Cannot inherit rules from a type hierarchy. |

**What the ontology provides.** Traverse from the patient's `INSTANCE` to its
`Condition` schemas, then to `Treatment` and any `Contraindicated` links. The decision
context is:

- The patient *is* classified as diabetic (schema link, not a string match).
- `Insulin Therapy` inherits requirements from its schema ancestors (required labs,
  monitoring rules).
- An active `Heart Failure` instance linked through the contraindication schema *blocks*
  the path — a structural fact, not a keyword.

An agent or clinician sees **the governing types and their inherited rules**, not a pile
of rows or similar notes. The rationale is explainable: "blocked because
`Heart Failure` → `Contraindicated` for `Insulin Therapy`."

---

### Example 2 — AML / enhanced due diligence (financial compliance)

**The ontology.**

```text
(Customer)              (Transaction)              (Jurisdiction)
    │                       │                           │
    ├── Enterprise ──► Wire Transfer ──► High-Value (≥ $10k)
    │                       │                           │
    └── Politically         └──► Requires-EDD ◄─────────┘
        Exposed Person              │
                                    └──► Sanctions Screening (required STEP)
```

**The decision.** *Does this wire transfer require enhanced due diligence (EDD) before
release?*

| Approach | What context it provides | Why it falls short |
|----------|-------------------------|-------------------|
| **Relational tables** | `transactions.amount`, `customers.risk_tier`, lookup table `edd_rules` | Rules live in a separate rules engine or `if amount > 10000 AND tier = 'PEP'` code. PEP status and jurisdiction rules are disconnected tables; combining them means more joins and more deployed code. |
| **Documents** | A compliance checklist PDF or per-transaction JSON snapshot | Checklist is static. Jurisdiction-specific rules (EU vs. US) are duplicated per region or maintained in spreadsheets outside the transaction record. |
| **Vector search** | Similar past transactions and their outcomes | "Transactions like this were flagged" is anecdotal, not binding. Regulators want *which rule applied*, not *what looked similar*. |

**What the ontology provides.** From the transaction `INSTANCE`, walk to
`Wire Transfer` → `High-Value` → `Requires-EDD`, *and* from the customer `INSTANCE`
to `Politically Exposed Person`. Both schema paths converge on the same decision
context: the EDD requirement is **inherited from types**, not hardcoded. Attach the
`Sanctions Screening` `STEP` sequence to the `Requires-EDD` schema node and any
transaction that traverses there automatically gets the right workflow.

When regulators ask "why EDD?", the answer is the schema path — auditable and
versionable — not a similarity score or a buried `CASE` statement.

---

### Example 3 — Editorial publishing (CMS)

**The ontology.**

```text
(Content)           (Format)              (Policy)
    │                   │                     │
    ├── Interview ──────┼──► Video            │
    │       │           │                     │
    │       └───────────┼──► Editorial ──► Requires-Legal-Review
    │                   │                     │
    └── Press Release ──┘                     └──► Requires-Executive-Signoff
```

`Interview` `POINTS_TO` both `Video` and `Editorial` — heterarchy. A single article
inherits publishing rules from **both** ancestors.

**The decision.** *Can this interview be published without additional review?*

| Approach | What context it provides | Why it falls short |
|----------|-------------------------|-------------------|
| **Relational tables** | `articles.type = 'interview'`, `articles.format = 'video'`, boolean flags `needs_legal`, `needs_exec` | Multiple inheritance is awkward: is an "interview" that is also "video" one row or two? Adding a new content type means ALTER TABLE and updating every flag combination in code. |
| **Documents** | Frontmatter tags: `{ "type": "interview", "format": "video" }` | Tags are flat strings. "Interview + Video" inherits legal review *and* video-specific transcoding rules only if someone remembered to encode that matrix in the template. |
| **Vector search** | Similar published articles | Might surface articles that *look* like this one but were published under a different policy regime (pre-legal-review rule). Similarity ignores *when* and *under which schema* something was approved. |

**What the ontology provides.** Traverse from the article `INSTANCE` up through
`Interview` to both `Video` and `Editorial`. Collect every `Policy` schema reachable
from any ancestor: `Requires-Legal-Review` (from Editorial) plus any video-specific
requirements (from Video). The decision context is the **union of inherited policies** —
automatic, complete, and explainable.

Change the rule once on the `Editorial` schema node and every future `Interview` (and
every other editorial subtype) picks it up without touching individual articles.

---

### Example 4 — Vendor qualification (procurement / supply chain)

**The ontology.**

```text
(Vendor)                    (Certification)           (Contract Type)
    │                            │                         │
    ├── Domestic Supplier ──► ISO-9001 ──► Federal-Eligible
    │         │                    │                         │
    │         └──► Small Business ─┘                         │
    │                                                        │
    └── Foreign Supplier ──► Not Federal-Eligible            │
                                                             │
    Federal Contract ◄───────────────────────────────────────┘
         │
         └──► Requires: Federal-Eligible vendor + active ISO-9001
```

**The decision.** *Can we award this federal contract to Vendor X?*

| Approach | What context it provides | Why it falls short |
|----------|-------------------------|-------------------|
| **Relational tables** | `vendors.country`, `certifications` join table, `contracts.type` | Qualification is a multi-table EXISTS query rewritten for each contract type. Adding "Small Business set-aside" means new columns and new application branches. |
| **Documents** | Vendor profile PDF + cert scans attached to a folder | Certs expire silently; nothing links "this cert satisfies *that* contract requirement" structurally. A human must re-read documents for every award decision. |
| **Vector search** | "Vendors similar to ones we've used on federal work" | Past usage is not qualification. A similar vendor may lack the specific certification chain the contract type requires. |

**What the ontology provides.** From `Federal Contract`, traverse to its requirements
(`Requires: Federal-Eligible + ISO-9001`). From Vendor X's `INSTANCE`, traverse its
schema links: is it under `Domestic Supplier` → `ISO-9001` → `Federal-Eligible`, or
does it hit `Foreign Supplier` → `Not Federal-Eligible`? The decision is a **path
existence check** against a published ontology — not a manual checklist and not
"we used someone like this before."

Bonus: when `ISO-9001` expires, update the certification `INSTANCE` status and every
downstream eligibility decision reflects it on the next traversal — no hunting through
document folders.

---

### Example 5 — IT change management (operations)

**The ontology.**

```text
(Change)                (Environment)              (Approval)
    │                        │                         │
    ├── Standard Change ──► Development                │
    │                                                    │
    ├── Normal Change ──► Staging ──► CAB-Review       │
    │         │                                          │
    │         └──► Production ──► CAB-Required           │
    │                        │                         │
    └── Emergency Change ──► Production ──► Post-Hoc-CAB │
```

**The decision.** *Does this production database migration require CAB approval before
execution?*

| Approach | What context it provides | Why it falls short |
|----------|-------------------------|-------------------|
| **Relational tables** | `changes.category`, `changes.environment`, workflow state columns | Routing rules in a workflow engine config file, disconnected from the change record. "Emergency + Production" is a special case added as another `WHEN` clause somewhere. |
| **Documents** | Change request form with dropdowns | Dropdown values drift from actual policy. An engineer picks "Standard" because the form allows it, even though the target environment makes it `CAB-Required`. |
| **Vector search** | Similar past changes and whether CAB was involved | Historical inconsistency ("we skipped CAB last time") is not policy. Similarity normalizes bad precedents. |

**What the ontology provides.** The change `INSTANCE` links to `Normal Change`; its
target environment `INSTANCE` links to `Production`. Traverse
`Normal Change` → `Production` → `CAB-Required`. The approval requirement is **derived
from the type + environment combination** in the ontology, and the corresponding
`STEP` sequence (CAB review workflow) attaches to the `CAB-Required` schema node.

The decision context for the engineer, the agent, and the auditor is identical: the same
schema subgraph, not three different interpretations of a form.

---

### Example 6 — Contract terms selection (legal)

**The ontology.**

```text
(Agreement)              (Governing Law)            (Data Handling)
    │                         │                         │
    ├── MSA ──────────────────┼──► US Law              │
    │     │                     │                         │
    │     └──► SOW ─────────────┼──► EU Law ──► GDPR-Covered
    │                           │              │
    └── DPA ────────────────────┘              └──► Requires-DPA
                                                      │
    Customer in EU + Personal Data ◄──────────────────┘
         │
         └──► Inherits: GDPR-Covered + Requires-DPA + EU Law terms
```

**The decision.** *Which standard terms and data-processing clauses must be included in
this agreement?*

| Approach | What context it provides | Why it falls short |
|----------|-------------------------|-------------------|
| **Relational tables** | `agreements.type`, `customers.jurisdiction`, `clauses` lookup | Clause selection is a Cartesian product maintained in code or a spreadsheet. A new regulation (e.g. a US state privacy law) means updating multiple tables and redeploying selection logic. |
| **Documents** | Template library with "EU MSA v3", "US SOW v2" | Templates multiply combinatorially (type × jurisdiction × data regime). Picking the wrong template is easy; the link between *this deal's facts* and *that template's assumptions* is implicit. |
| **Vector search** | "Agreements similar to this deal" | Surfaces deals with similar *language*, not deals governed by the same *rule set*. A US deal and an EU deal may read similarly but carry different obligations. |

**What the ontology provides.** From the deal's `INSTANCE`, traverse through `MSA` →
`SOW`, pick up `EU Law` and `GDPR-Covered` from the customer's jurisdiction link, and
collect `Requires-DPA` from the data-handling schema. The **full clause package** is the
set of schemas reachable from the agreement + customer + data classification — not a
best-guess template match.

Legal ops can attach clause text and approval `STEP` sequences to schema nodes. When
GDPR requirements change, update the `GDPR-Covered` schema once; every future EU deal
inherits the update.

---

### What these examples have in common

Across every domain, the ontology-as-context pattern repeats:

1. **The decision is about membership and inheritance**, not attribute lookup alone.
   "Is this vendor qualified?" and "Does this change need CAB?" are questions about
   which types apply and what those types imply.

2. **Context is assembled by traversal**, not by guessing which tables, tags, or
   documents to open. The same operation — walk `POINTS_TO` from the subject — works
   in healthcare, finance, publishing, and legal.

3. **Rules live on the types, not on the instances.** Changing policy means editing a
   `SCHEMA` node (or adding an edge), not rewriting thousands of records or redeploying
   application code.

4. **Heterarchy is native.** Real domains don't fit one tree. An Interview that is
   both Editorial and Video, or a Contractor who is both Person and Vendor, inherits
   from all applicable parents without schema migrations.

5. **The rationale travels with the context.** "We required EDD because
   `Wire Transfer` → `High-Value` → `Requires-EDD`" is inspectable. A vector
   similarity score or a hardcoded `if` statement is not.

In pona flow, this is the `SCHEMA`/`INSTANCE` split doing its job: schemas define the
*meaning and rules* of the domain; instances are the *facts* decisions are applied to;
sequences (`STEP` chains) are the *actions* that fire once the ontology context is clear.

---

## 4. Assembling *relevant context* for an agent or model

**The decisioning problem.** Before an LLM (or a person) can decide, it needs the right
context — not the whole database, and not just keyword-similar text, but *the records
connected to the matter at hand and the rules that govern them*.

**Why non-graph solutions struggle.** Vector search retrieves chunks that are
semantically *similar*, which is not the same as *related*: it will happily miss a
critical linked record that shares no vocabulary, and include lookalikes that are
irrelevant. Relational retrieval requires you to know in advance every table to join.
Neither expresses "everything pertinent to X, and only that."

**The context-graph approach.** "Pertinent" is a neighborhood. A `network` traversal
(`-[*]-`) from the entity in question pulls the connected subgraph — instances and the
schema rules they obey — which is exactly the bounded, relevant context an agent should
reason over. This is the heart of the product's framing as *agentic context
engineering*: the graph is the substrate for assembling state, memory, tools, and
working context, while SQLite payloads hold the nested detail the graph shouldn't carry.

- **PKM example:** "Give me everything I know that bears on this decision" returns the
  linked notes, people, and events — not a list of documents that merely share words.
- **Agentic example:** A support agent answering about an order gets the order, its
  customer, the customer's plan, and the policy schema for that plan — a precise context
  window assembled by traversal instead of guessed by similarity.

Crucially, structure-based retrieval is **explainable**: you can say *why* each record
was included (it was linked, by this edge), which similarity scores can't.

---

## 5. Explaining and auditing *why* a decision was made (provenance)

**The decisioning problem.** After a decision, you must justify it: "Why was this
escalated?" / "Which rule fired?" / "What path did this run take?" Regulated and
high-stakes workflows need this; so do humans debugging an agent.

**Why non-graph solutions struggle.** With logic in application code, the reasoning is
gone the moment the function returns. Tables store the *outcome* but not the *route* to
it, so explanations are reconstructed after the fact, if at all.

**The context-graph approach.** The path *through* the graph is the explanation. The
executor records exactly which steps ran and writes an audit-log entry per run:

```800:806:Engine/server/execution.py
        executed.append(
            {
                "step_id": step_id,
                "query_id": str(step.get("query_id") or ""),
                "endpoint": str(step.get("endpoint") or ""),
            }
        )
```

Because branching is encoded as edges, "why this branch?" answers itself: the run
followed the edge whose `condition_expected` matched the parameter. The decision and its
justification share one representation.

- **DSS / compliance example:** "Show the decision path for claim #1234" replays the
  exact `STEP` sequence and the conditions that selected each branch.
- **AMS example:** "Why did this task auto-approve?" — the executed-steps trail plus the
  edge conditions are a built-in rationale.

---

## 6. Evolving, heterogeneous relationships without migrations

**The decisioning problem.** Real decision domains grow new *kinds* of relationships
over time: today "reports-to", tomorrow "mentors", next quarter "covers-for". Decisions
need to use these new links as soon as they exist.

**Why non-graph solutions struggle.** Each new relationship type in a relational model
is a new join table or column — a schema migration, a deploy, and backfill. Document
stores force the new link into existing blobs. The cost of *adding a relationship* slows
down the evolution of *decision logic*.

**The context-graph approach.** New connections are just new `POINTS_TO` edges (with
descriptive properties in the payload); no migration is required to start relating
entities a new way, and traversals immediately pick them up. The single relationship
type keeps the model uniform while edge/payload properties carry the specifics.

- **CRM example:** Introduce a "referred-by" relationship between contacts and start
  answering "who drives our referrals?" the same day — no table changes.
- **AMS example:** Add a "blocks" link between tasks and dependency/decisioning queries
  work immediately.

---

## 7. Cycles, feedback loops, and recursive processes

**The decisioning problem.** Some processes loop: "keep requesting changes until
approved", "retry until success or N attempts", "escalate, reassess, repeat." The
decision is *when to exit the loop*.

**Why non-graph solutions struggle.** Relational models have no natural notion of a
cycle; loops are simulated in application code or scheduled re-runs, with state smeared
across rows. Reasoning about termination is hard when the loop isn't represented.

**The context-graph approach.** A loop is simply an edge that points back to an earlier
`STEP`, with an exit edge guarded by a condition. The executor tracks visited steps and
resolved parameters on the state row, so a run can pause (e.g., waiting for human input)
and resume exactly where it left off:

```773:793:Engine/server/execution.py
        unresolved = [
            p
            for p in (step.get("parameters") or [])
            if isinstance(p, dict)
            and p.get("is_required")
            and str(p.get("name") or "").strip() not in resolved
            and str(p.get("name") or "").strip() not in response_param_names
        ]
        if unresolved:
            catalog.update_state_progress(
                state_id,
                {"queue": queue, "resolved": resolved, "visited": list(visited)},
            )
            catalog.update_state_status(state_id, "pending")
            return {
                "status": "pending",
                "state_id": state_id,
                "step_id": step_id,
                "parameters": unresolved,
                "resolved": resolved,
            }
```

- **AMS example:** A review loop that cycles "request changes → revise → re-review" and
  exits on an `approved` parameter — the cycle is two edges, not a cron job.
- **Agentic example:** A reasoning loop that retries a tool until a success flag flips,
  with the loop boundary and exit condition both visible in the graph.

---

## 8. Structural pattern decisions (subgraph matching)

**The decisioning problem.** Some decisions are about *shapes*: "find rings of accounts
that all transact with each other" (fraud), "recommend what similar users connected to"
(recommendation), "find the diamond dependency." The signal is the *pattern of
connections*, not any single value.

**Why non-graph solutions struggle.** Matching a connection pattern in SQL means a
combinatorial pile of self-joins that explodes as the pattern grows, and the query has
to be rewritten for every new shape. Vectors can't see structure at all.

**The context-graph approach.** pona flow queries are built from graph patterns —
nodes and relationships with directions, lengths, and conditions — so a structural
question is expressed as the pattern you want to match:

```107:130:App/composer/src/types.ts
export interface RelationshipPattern {
  variable: string;
  alias_mode?: AliasMode;
  alias_ref?: string;
  alias_locked?: boolean;
  attributive_label?: string;
  type?: typeof GRAPH_REL_TYPE | string;
  direction?: "incoming" | "outgoing";
  length?: RelationshipLength;
  properties: PropertyBinding[];
  id_binding?: GraphIdBinding;
  condition?: string;
  condition_type?: ConditionType;
  // ...
}
```

- **DSS / risk example:** Detect mutually-connected clusters by matching the cyclic
  pattern directly rather than joining a transactions table to itself repeatedly.
- **CRM example:** "Customers connected to two or more churned accounts" is a pattern
  match, not a stack of joins.

---

## When a context graph is *not* the better tool

Honesty makes the rest credible. Graphs are not universally superior, and pona flow is
deliberately *hybrid* because of it:

- **Bulk attribute queries and aggregations** ("sum revenue by month") are a relational
  strength; do them in SQL.
- **Querying deeply nested arrays/objects inside a single entity** is precisely where
  graph databases are weak — which is why pona flow keeps that data in **SQLite
  payloads** alongside the graph rather than forcing it into nodes and edges. The
  `entities` table stores each node's nested `payload` as JSON for exactly this reason.
- **Pure semantic similarity over free text** is a vector-store job. A context graph
  complements it (structure + provenance) rather than replacing it.

The design rule: **use the graph for relationships and routing, use SQLite for the
nested data within an entity, and reach for vectors when the question is "what's
similar."** pona flow's value is in making the first two work together so decisions can
be both *connected* and *detailed*.

---

## Summary

| Decisioning problem | Graph wins because… | Non-graph pain |
|---------------------|---------------------|----------------|
| Multi-hop eligibility / impact | Reachability & variable-length paths are native | Unknown-depth self-joins |
| Workflow routing / branching | Conditions live on edges next to the steps | Logic hardcoded in app/`CASE` |
| Classification & inheritance | Taxonomy/heterarchy via `POINTS_TO`; rules inherited by traversal | Rigid single hierarchy; migrations |
| Context assembly for agents | Neighborhood traversal returns *related*, explainable context | Similarity ≠ relatedness |
| Explainability / audit | The traversed path *is* the rationale | Outcome stored, route lost |
| Evolving relationships | New edges need no migration | Schema change per relationship |
| Loops / recursion | Loop = back-edge with a guarded exit; resumable state | Simulated in code/cron |
| Structural patterns | Match the shape directly | Combinatorial self-joins |

Across all eight, the throughline is the same: **decisions are about relationships, and a
context graph stores relationships as first-class, queryable, inspectable structure.**
Non-graph stores can hold the facts, but they make the *connections between facts* —
where the decision actually lives — implicit, expensive, or invisible.
