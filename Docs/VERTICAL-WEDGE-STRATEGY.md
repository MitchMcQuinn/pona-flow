# Vertical Wedge Strategy: From Horizontal Platform to Micro-SaaS

**Context.** pona flow was built horizontally — a generalized graph-native workflow
platform in the same conversational space as n8n. Competing horizontally requires
capital, connectors, and distribution a solopreneur doesn't have. This document
recommends which path to take, which vertical to pick, how to pitch it, and a 90-day
plan for a small, winnable first product with residual-income potential.

**Revision note (v2).** The original draft recommended vendor/subcontractor
compliance tracking. After weighing founder domain familiarity — years of DAO
community operations: resource distribution, proposal management, community
moderation — the recommended wedge is now **grant-round operations for small
grantmakers and participatory funds**. It is the same job as DAO treasury/grants
operations with the crypto culture removed, and it applies the unfair-access
tie-breaker from Section 2 honestly: familiarity with the *work* transfers even
though the *scene* changes. Vendor compliance is retained as a fallback candidate.

---

## 1. The three paths, and the recommendation

There are three ways to apply this project vertically:

| Path | What it means | Verdict |
|------|--------------|---------|
| **A. Configured instance** | Stand up a pona flow instance per client, configure the ontology for their domain, charge for hosting + management (the current D1/D2 model) | Good *revenue bridge*, but it's a service. Income scales with your hours, not residually. |
| **B. Invisible engine** | pona flow runs the vertical product, but the customer never sees STEP/SCHEMA/INSTANCE. They see a narrow, branded tool that answers one expensive question in their domain. | **Recommended.** This is the micro-SaaS play. |
| **C. Lessons only** | Abandon the codebase, rebuild greenfield with the meta-ontology as design philosophy. | Only justified if the engine were a liability. It isn't — it's a working asset with tests, HITL, templates, and an MCP gateway. Throwing it away resets you to zero. |

**Recommendation: Path B, sequenced through Path A.**

Start by hand-configuring 2–3 paid pilot instances in one vertical (Path A — this is
your customer discovery, and they pay you to do it). The configuration that survives
contact with real clients becomes a **template** — pona flow already has template
export/import (`Engine/server/templates.py`) built exactly for stamping out
configured spaces. That template, wrapped in a thin vertical UI, *is* the micro-SaaS.

The key mental shift: **stop selling the ontology, start selling one decision the
ontology is uniquely good at making.** Nobody buys a meta-ontology. People buy "never
get burned by X again" or "never have to reconstruct why we decided Y."

### On "invisible ponaflow" and the agent-configured ontology

The ontology should be invisible to the customer *from day one* — but the thing
configuring it should be **you**, not an agent, for the first several clients. You
are the cheapest, most reliable "agent" available, and every configuration call
teaches you what the template should contain. Once the vertical template stabilizes
(onboarding call #4 feels like a rerun of call #3), *then* automate the interview:
an LLM reads the client's guidelines document or intake form and emits a template
import. The MCP gateway (`Engine/server/mcp_gateway.py`) means an agent can also
*operate* the instance, not just configure it.

So the answer to "instance vs. invisible" is: **both, in layers.** Instance-per-client
underneath (the D2 tenancy model, unchanged), invisibility on top (they see a
vertical app, not a graph workbench), agent automation last (once you know what to
automate).

---

## 2. Which vertical: the selection rubric

The system's genuine strengths — from `Docs/CONTEXT-GRAPH-DECISIONING.md` — define
what a good wedge looks like. Score candidate verticals against these five criteria:

1. **The core decision is relational, not attributive.** Eligibility, qualification,
   inheritance, routing — "is A connected to B through a valid chain?" If the
   decision is "sum a column," Airtable wins and you shouldn't fight it.
2. **The answer must be *explainable*.** Someone (board, funder, member, auditor)
   asks "why?" and the traversal path *is* the answer. This is the moat against
   both spreadsheets and pure-LLM tools, which can't show their work.
3. **Rules change on the type, not the record.** When a policy updates, it should
   propagate to hundreds of records via one schema edit. Domains with versioned,
   inherited policy are where SCHEMA nodes earn their keep.
4. **A human approval sits in the loop.** The native `pending`/resume execution
   state is a real differentiator; most niche tools bolt this on badly.
5. **The buyer is small and reachable.** No procurement committee, active
   communities/associations, incumbents are either spreadsheets or
   enterprise-priced. A solopreneur can win these with warm outreach and one demo.

**Plus the tie-breaker: unfair access.** Warm familiarity with the work and the
people beats a marginally better market every time.

### Why the DAO domain itself is out (and what transfers)

DAO governance tooling scores well on criteria 1–4 — pona flow's whole thesis, the
gap between policy prose and execution, is arguably *the* unsolved DAO problem. But
it fails on sustainability grounds that matter more for a solopreneur: the market is
crowded with governance tools competing on token mechanics rather than execution;
distribution runs through conference circuits and Twitter spaces you find corrosive;
and founder-market *fit* includes wanting to spend years with the customers. Bruised
moral idealism is a real cost input. Don't route around it — route the *skills*
around it:

| DAO operations skill | Non-DAO equivalent |
|----------------------|--------------------|
| Treasury / resource distribution | Grant rounds, participatory budgets, disbursement pipelines |
| Proposal lifecycle management | Application/motion intake → eligibility → review → decision → execution |
| Quorum, voting thresholds, role gating | Review-committee routing, conflict-of-interest rules, sign-off thresholds |
| Community moderation & membership rules | Eligibility screening, member-standing rules, escalation workflows |
| "Policy prose vs. what actually happens" | Guidelines documents vs. how decisions actually get made — the exact same gap |

The job you already know how to do is **operationalizing collective decision-making
about money**. That job exists, at much larger scale and with far gentler culture,
in philanthropy.

### Three candidates

**Candidate 1 (the pick): Grant-round operations for small grantmakers and
participatory funds.** Giving circles, small-staff foundations (Exponent
Philanthropy's entire membership is funders with ≤3 staff), community foundations'
micro-grant programs, mutual aid funds, arts councils, participatory budgeting
programs. Their round lifecycle — publish guidelines, take applications, screen
eligibility, route to reviewers, deliberate, decide, disburse, chase reports — runs
today on Google Forms, spreadsheets, email threads, and meeting minutes. This *is*
DAO grants ops without the token. Section 3 details the fit.

**Candidate 2 (runner-up): Governance operations for member-run organizations.**
Housing/food/worker co-ops and professional associations: motion lifecycle,
committee routing, bylaws-as-executable-policy, membership standing. Strong values
alignment and the same skill transfer, but weaker willingness to pay — co-ops are
chronically budget-constrained — so it's the fallback if grantmakers don't convert.

**Candidate 3 (fallback from v1): Vendor/subcontractor compliance tracking.** Still
a structurally sound wedge (see git history for the full v1 write-up), but it fails
the unfair-access tie-breaker for this founder: no familiarity with the buyers, the
domain, or the communities. Parked, not deleted.

### Why the incumbents leave room (Candidate 1)

The grants-management market is real but stratified. Fluxx and SmartSimple are
enterprise. Submittable and Foundant GLM serve small-to-mid foundations at custom
quotes generally in the $3k–$25k+/year range plus setup fees — and both are
**form- and application-centric**: they are excellent at collecting submissions and
scoring them, and thin at the part pona flow is built for, which is making the
*policy itself* executable. Below them is a long tail — giving circles, volunteer-run
funds, funds run by 0.5 FTE inside a larger org — priced out entirely and running on
spreadsheets. That long tail is the beachhead: buyers who cannot justify $5k/year
for Foundant but will pay $100–250/month to stop losing decisions in email threads.

---

## 3. What the product actually is

Working name for illustration: **"Rounds"** — grant rounds, run by your own rules.

### Why pona flow specifically fits this job

This is the concrete mapping, not an analogy:

- **Eligibility is schema inheritance.** "This round funds 501(c)(3)s or fiscally
  sponsored projects, in these counties, up to $10k, unless the applicant received
  funding in the last cycle" is a chain of SCHEMA nodes: org-wide policy → program →
  round, with the round inheriting and overriding. An application's eligibility is a
  path-existence check from its INSTANCE up through the applicant-type and round
  schemas — Examples 2, 3, and 6 in `CONTEXT-GRAPH-DECISIONING.md` are literally
  this shape. When the board changes a rule, you edit one schema node and every
  pending application re-evaluates; in a spreadsheet, someone re-reads 80 rows.
- **The review process is a STEP chain with guarded edges.** Route by category,
  screen for conflicts of interest (reviewer INSTANCE linked to applicant INSTANCE →
  recuse edge fires), branch on score thresholds, loop "request more info → resubmit
  → re-review" — the executor's back-edges and `condition_expected` branching do
  this natively.
- **Human-in-the-loop is the product, not a feature.** Every consequential step in
  grantmaking pauses for a person: eligibility confirmation, reviewer scores, the
  decision meeting, disbursement sign-off. pona flow's `pending`/resume state
  machine is exactly this contract, and it's already exercised end-to-end in tests.
- **Provenance is the killer demo.** "Why did we fund X and not Y?" and "show me
  every application's path through last spring's round" fall out of the executed-
  steps trail for free. Boards, community reviewers, and (for public funds)
  journalists ask these questions; spreadsheets and Submittable both answer them
  badly.
- **The plumbing is already built.** Intake arrives from whatever form tool they
  already use (Tally, Jotform, Google Forms) via the external webhook receiver
  (D10). Deadline nagging — reviewers who haven't scored, grantees whose reports
  are due — is the scheduler. Multi-round templates are the template system.

### What the customer sees (never the graph workbench)

- **A round board**: applications with one status column — *Eligible / Ineligible /
  In Review / Needs Info / Recommended / Awarded / Declined / Paid* — and a "why"
  link on every status that renders the rule chain in plain English ("Ineligible:
  applicant is a 501(c)(4); the Spring Arts round funds 501(c)(3) or fiscally
  sponsored projects only").
- **Intake that meets them where they are**: keep their existing application form;
  submissions flow in via webhook, eligibility screens automatically, a human
  confirms edge cases.
- **Review routing**: reviewers get assignments by category with conflicts screened
  out, submit scores through a simple link, and the round advances when thresholds
  are met — no more "did everyone score packet 3?" emails.
- **Decision-meeting packet**: everything recommended, with rationale chains, in one
  export. After the vote: award letters triggered, disbursement checklist opened,
  report deadlines scheduled.
- **The audit answer**: one click reconstructs any past decision's full path. For
  participatory funds this is not compliance theater — showing the community *how*
  decisions were made is the point of the model.

### What to build (deliberately small)

1. A thin front end (round board + application detail + why-view) over the existing
   FastAPI — the sequence webhook and discovery endpoints (D8) already exist.
2. An intake sequence template (webhook → screen → HITL confirm → status update).
3. The round ontology template for one sub-niche's typical guidelines, exported via
   the templates feature.
4. A per-instance provisioning script (`BETA-READINESS-REVIEW.md` already flags ops
   automation as the gap; closing it for exactly one shape of instance is far easier
   than solving it generally).

Do **not** build: fund disbursement/payments (partner or punt — link out to their
existing process), native form-tool integrations beyond the generic webhook,
multi-vertical config, agent-interview onboarding, or self-serve signup. All of
that comes after revenue.

---

## 4. Identifying and pitching: specific advice

### Finding the first ten conversations

- **Go where the operations people are, not where the software is reviewed.**
  Exponent Philanthropy (the small-staff funder association), PEAK Grantmaking
  (grants-ops professionals — this is the community that talks openly about broken
  process), Philanthropy Together (the giving-circle network), regional grantmaker
  associations, and community-foundation program officers who run micro-grant
  rounds as a side duty. These communities are values-driven, collegial, and
  allergic to exactly the hype culture you're escaping. Your DAO-ops story,
  reframed as "I spent years running participatory funding processes on the open
  internet," is a *credential* here, not a liability.
- **Lead with an artifact, not a pitch.** Offer a free **"round retrospective"**:
  they send you last round's application spreadsheet and their guidelines PDF; you
  load it into an instance and send back a one-pager — N applications reviewed that
  were ineligible under their own written guidelines, M decisions that can't be
  reconstructed from the records, average days stuck in each stage. The subject
  line writes itself: *"Your guidelines say X. Your last round did Y."* It costs
  you an hour, demos the product with their own data, and is quietly your
  onboarding process.
- **Ten warm messages a day beats any launch.** Micro-SaaS at this stage is
  founder-led sales, and this niche runs on referrals and listservs, not Product
  Hunt.

### The pitch itself

- **Sell the reconstruction problem, not the workflow.** The opener: "When a board
  member or community member asks why applicant X was declined two cycles ago, how
  long does it take you to answer, and how confident are you in the answer?" Then
  stay silent. The answer is always someone's memory plus an email search.
- **Never say ontology, graph, meta-, or workflow.** Customer vocabulary: *rounds,
  guidelines, eligibility, reviewers, conflicts, awards, audit trail.* The
  meta-ontology is your manufacturing advantage — it's why a new client goes live
  in a day and a guideline change is one edit — not your marketing.
- **Demo two moments.** First, the "why" click on an Ineligible status expanding
  into its plain-English rule chain. Second, changing one guideline and watching
  statuses re-evaluate across the round. Together they say: *your guidelines,
  executable* — which is the "gap between policy prose and execution" thesis,
  translated out of DAO language.
- **Price beneath the incumbents' floor.** $99–$249/month per fund (or per-round
  pricing for circles that run one or two rounds a year, e.g. $500/round),
  concierge onboarding included. Foundant and Submittable quote in thousands with
  setup fees; spreadsheets are free but cost them their credibility. You sit in the
  empty middle. Annual prepay discount from day one.
- **Founding-customer offer for the first 3–5:** half price for a year, in exchange
  for a 30-minute call each month and permission to reuse their round setup
  (anonymized) in the template. This is Path A funding Path B's template.

### Residual-income mechanics

Residual income requires that marginal clients cost near-zero marginal hours. Three
things get you there, in order: (1) the **template** eliminates per-client ontology
design; (2) the **provisioning script** eliminates per-client setup; (3) the
**agent-interview onboarding** (phase 2, via MCP: an LLM reads their guidelines PDF
and drafts the round ontology for your review) eliminates the configuration call.
Track one metric honestly: *hours from signed to live*. When it drops under two, you
have a product; until then you have a well-leveraged service — which is fine,
because it's paying you while you get there.

A note on seasonality: grant rounds are cyclical, so favor annual pricing and
multi-program funds, and treat "between rounds" as when report-chasing and
next-round setup keep the tool sticky.

---

## 5. 90-day plan

**Weeks 1–2 — Commit and script.** Pick the beachhead sub-niche (giving circles vs.
small-staff foundations — go where your warmest introduction is). Write one typical
round's ontology as a template. Build the round-retrospective script/sequence so a
spreadsheet + guidelines PDF becomes a report in under an hour. No new UI yet.

**Weeks 3–6 — Sell the retrospective.** Ten outreach messages a day into PEAK /
Exponent / Philanthropy Together circles and your own network. Goal: 10
retrospectives delivered, 5 calls, 2–3 founding customers at the discounted rate,
onboarded concierge-style onto hand-configured instances. You are the UI: a weekly
emailed round-status report generated by a scheduled sequence is a shippable v1,
and the scheduler already does this.

**Weeks 7–10 — Build only what pilots demanded.** The thin front end (round board +
why-view + reviewer links), the intake sequence, deadline reminders. Freeze the
template around what founding customers actually needed.

**Weeks 11–13 — Systematize.** Provisioning script; full price for new customers;
ask each founding customer for two introductions — this niche is densely networked
through the same associations you sourced them from, and referrals will outperform
every other channel combined. Decision gate at day 90: with ≥3 paying and a
repeatable onboarding, keep going and start the agent-interview automation. If you
couldn't get 3 paying after ~40 real conversations, swap to Candidate 2 (member-org
governance) and rerun weeks 1–6 — the template system means switching costs weeks,
not months. That portability is the horizontal investment finally paying off.

**A later door, on your terms:** if Rounds works, the DAO-adjacent world comes to
*you* — protocol foundations and crypto grant programs are increasingly run by
professional grants-ops people who dislike the culture as much as you do, and they
buy tools like anyone else. You never have to attend the conference.

---

## 6. What this means for the existing decision log

- **D1 (open-core, managed instances)** survives but inverts emphasis: the managed
  single-tenant instance stops being *the product* and becomes *the fulfillment
  mechanism* behind a vertical brand. Open-core marketing of pona flow itself goes
  on the back burner — it's a distribution strategy for a horizontal audience
  you're no longer chasing first.
- **D2 (single-tenant)** is now an asset, not overhead: "your fund's data lives in
  your own isolated instance" lands well with fiscally sponsored and
  community-governed funds.
- **D9 (MCP gateway)** graduates from "paid add-on feature" to the substrate of
  phase-2 automation (agent-drafted round ontologies, agent-operated status
  reporting). Keep it closed; it's now strategic rather than monetizable-per-seat.
- **D10 (generic webhooks, no native connectors)** turns out to be the right call
  for this play: form-tool submissions, reviewer score links, and email gateways
  all arrive through the one receiver you already built.

The one-sentence version: **keep pona flow as your engine, make it invisible, and
sell one relational decision — grant-round eligibility and its audit trail — to
small grantmakers and participatory funds: the DAO-ops job you already know,
minus the DAO.**
