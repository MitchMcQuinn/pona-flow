# The Monday checklist

pona flow is a private workspace for routine work that cannot move until several things line up at once: a dependency, a stakeholder, a service, a database, and a fact that may arrive later.

The steps themselves are ordinary. Clear a contractor. Route a claim. Renew an account. Publish a page that has to obey a legal category. The same checklist runs every week. What changes is the context around it, and that context is usually scattered across tools that cannot see each other.

This note walks one Monday, then shows how the same shape applies anywhere the next action depends on what a record is, who it is tied to, and what is still missing.

## A Monday at the studio

Maya runs operations for a small studio. Every Monday a new contractor has to be cleared before payroll. The checklist never changes shape:

1. Find the person and the company they bill through.
2. See which rules apply. A contractor can be both a person and a vendor.
3. Call a screening service.
4. If the contract is high-value, ask legal to sign.
5. If the tax form is missing, wait until it shows up.
6. Write the result back so finance can pay them.

None of those steps is exotic. Together they touch a record, a rule, another company, an outside API, two humans, and a document full of line items. Last quarter Maya did this with a wiki page, a spreadsheet, an automation, a chat thread, and a prompt. Each one held a piece of the morning. When legal asked why a contractor was cleared, she had the outcome and a pile of tabs.

pona flow is the place where that Monday stays one piece of work.

## Six rooms, then one

![Six rooms — wiki, spreadsheet, automation, search, chat, and a prompt — then one room for meaning, records, and work](visuals/01-split-stack-vs-one-model.png)

Picture the left side as six desks in six rooms.

The policy sits in a wiki. The contractor sits in a spreadsheet that pretends to be a CRM. The "what happens next" sits in an automation tool, where a field is just a field. A search index can find a paragraph that *sounds* like this case and still miss the parent company, because that company uses different words. An agent framework can talk about the case. A hand-built tool can act on it. Maya spends the morning walking between rooms, rebuilding a story those systems never shared.

That walk is the expensive part. The screening call is cheap. Reconstructing "who this person is, which rule covers them, and who still has to sign" is what eats the week, and it eats it again next Monday.

The right side is one room. The picture names the three things in plain words: meaning, records, and work. The next pictures give them their names.

- **Schema** is the meaning. Contractor, vendor, high-value contract, and the rules those types carry.
- **Instance** is the record. This person, this company, this open agreement.
- **Step** is the work. Find the person, check the rule, call screening, ask legal, wait for the form.

Humans start that work from a dashboard. An agent starts the same work as a tool. When the tax form is missing, the run stops and names what it still needs, and it keeps a handle so the same Monday can continue.

An analogy that holds: a relay where every runner has a different map. pona flow hands them one map, and the map is also the route.

## Three kinds of things, one kind of link

Schema is the rulebook. A contractor is both a person and a vendor. High-value requires legal review. The rule lives on the type.

![Schema: a contractor is both a person and a vendor, and high-value requires legal review](visuals/07-schema.png)

Instance is the chart. This person bills through this company, and this company holds this agreement.

![Instance: this person links to this company, which links to this agreement](visuals/08-instance.png)

Step is the checklist from the start of the Monday. A sequence is the name of the first step.

![Step: find the person, check the rule, call screening, ask legal, wait for the form](visuals/09-step.png)

Seen together, each lane links only to itself. Same Monday. Separate lanes.

![Three lanes recap: schema, instance, and step, each linking only to itself](visuals/10-lanes-recap.png)

Maya's Monday is easier to see as three lanes that stay in their own lane.

The **rulebook** links rules to rules. "Contractor" sits under "person" and under "vendor." "High-value" carries an extra review. Change the rule once, on the type, and every record of that type inherits it. She does not paste the policy into a thousand spreadsheets.

The **chart** links records to records. This person bills through this company. This company holds this agreement. Ask "who is behind this invoice?" and the answer is a walk along those links, including links she did not know the length of when she asked.

The **checklist** links steps to steps. Find the person. Check the rule. Call screening. Ask legal. Wait for the form. Each arrow can be a plain "always," or it can carry a condition: high-value goes to legal, and everyone else continues.

Those lanes connect with the same kind of link, `POINTS_TO`, and a link stays inside its lane. Rules point at rules. Records point at records. Steps point at steps. A sequence is simply the name of the first step. The executor walks from there.

Think of a hospital. The protocol manual cites other protocols. The patient chart cites other charts: insurer, attending, prior visit. The nurse's round is a route from room to room. You can read all three during one visit. You do not staple a page of the protocol onto the round with the same fastener you use between rooms. Meaning, records, and work stay distinct, and the visit is what brings them into the same hour.

That is the niche in structural form. Routine work is a route. The route is only trustworthy when the rules and the records are in the room with it.

## The walk, including the part where someone has to go find a form

![A guarded branch beside a pause that resumes the same run](visuals/03-execution-walk.png)

Two things happen on Maya's checklist, and they are different.

**A branch** is a choice the checklist already knows how to make. Two arrows leave the step. One is labeled high-value, so the next step is legal. The other is everyone else, and they continue. Changing that line is editing the arrow. The dashboard shows the same arrows the executor walks, and an auditor can replay the one that matched.

![The trace: this agreement, high-value, legal review](visuals/11-the-trace.png)

"We asked legal because this agreement is high-value, and high-value requires legal." That sentence is a path. A wire transfer can be read the same way: extra diligence because this payment is a high-value wire.

**A pause** is a fact the checklist does not have yet. The tax form never arrived. The run does not invent a number and it does not open a side system called "tasks." It stops, marks itself `pending`, and returns two things: what is still required, and a `state_id`. That id is the coat check for this Monday. Maya, the contractor, or a later call hands the form back with that id, and the same run continues.

Timers and outside events wait under a different sign, `waiting`, so a clock is not mistaken for a form someone has to fill in. A loop can stop in the middle of a pass and continue that same pass when the missing piece shows up.

The storytelling version: the checklist is a person walking a building. At a fork, the sign on the door says which hallway matches today's facts. At a locked door, they do not kick it in and they do not start a second trip. They take a number, go get the key, and resume the same walk.

This is where timely input belongs. A stakeholder approval, a file that lands at 4 p.m., a webhook from payroll, a sanctions result that was not in the database at 9 a.m. The routine is durable enough to wait for the thing that makes the routine true.

## One checklist, three ways to start it

![Dashboard, webhook, and a chat tool opening one checklist](visuals/04-one-run-three-doors.png)

By noon the same checklist has been started three ways, and all three are the same run.

Maya presses it on the dashboard because a producer Slacked her a name. The payroll system fires a webhook because a new contractor row appeared overnight. An assistant sitting in a chat tool calls it as an MCP tool, with the same permission key the studio issued for agents, because someone asked "can we pay this person?"

All three doors enter `run_sequence_once`. The sequence they enter is the one Maya's team authored. If the tax form is missing, each door hears the same pause and the same `state_id`. If legal has to sign, each door is looking at the same branch.

The analogy is a clinic with a front desk, a phone line, and a referral portal. The chart inside is one chart. You do not want the portal to invent a second protocol because it arrived as software.

That is the practical promise for stakeholders and services. People, other systems, and agents share the work. A new capability is a sequence someone saved, and it is callable without a new server written beside the checklist. The space itself is the tool list.

## Say it once

![A package compiled into Cypher for the graph and SQLite for nested data](visuals/05-composer-dual-write.png)

Maya should not have to keep two notebooks.

The graph is the right place for "this person bills through this company" and for "this step leads to that step." It is a poor filing cabinet for the contract's line items, the address list, or a set of clauses. Those live in a per-record store, SQLite, one database per space.

The composer is the translator between the way an author describes the work and those two stores. A package says what the schema, the instance, or the step is. The composer writes the Cypher that updates the graph and the SQLite statements that update the nested data. Authors describe the work once. The dual write is the compiler's job, the way a kitchen ticket goes to the grill and the pantry from one order spoken at the pass.

When an agent helps *build* the checklist, through the authoring tools, what it saves is the same artifact the visual builder reopens. The Monday the team runs and the Monday the team edits are not two translations of each other.

## A map, a folder, and a "sounds like" index

![Neo4j for links and routing, SQLite for nested values, vectors as an optional similarity read](visuals/06-where-data-lives.png)

Three questions come up before lunch. Each one has a home.

**What is connected, and which way do we turn?** That is the graph, in Neo4j. Links between records. Links between rules. Links between steps, including the guard that sent this contract to legal. Reach for this when the answer is a path: who owns this, what else breaks, which policy applies, which step is next.

**What is inside this one thing?** That is SQLite. The clauses, the line items, the list of addresses. Graphs are clumsy with that kind of nested detail, the way a street map is clumsy if you try to draw every receipt taped to a shop window. The receipt stays in the folder for that shop.

**What sounds like this?** That is an optional vector read over properties the team chose to index. It helps when someone asks in different words. It is a poor substitute for the map. A note that *sounds* like this contractor can still be the wrong company, the wrong plan, or a policy that does not govern them. Similarity is welcome at the table. It does not get to pretend it is relatedness.

Use each store for the question it answers. The Monday needs all three, and it needs them to stay distinct so "why did we clear them?" remains a path someone can point at.

## The same Monday, in other buildings

The studio is a stand-in. The shape shows up wherever a repeated task is really a gathering:

- A support lead opens a case and needs the account, the plan, the parent company, and the policy those types inherit, then a refund service, then a manager if the amount is over a line.
- A publisher moves a page from draft to live only after the legal category on its type says who must sign, and after a rights service returns.
- A renewal clerk walks the chain of who owns an account, calls billing, and waits on a usage figure that will not exist until the month closes.
- An access review follows reporting lines of unknown length, then pauses for the one owner who has to confirm.

In each case the dependencies are other records, the stakeholders are people with a required input, the services are calls the checklist makes, the databases are the map and the folder, and the timely input is the fact that arrives after the run has already started. pona flow is built to hold that gathering as one inspectable run, on a private instance, with a separate space when a client or a project should stay fenced off.

Broad connector catalogs, warehouse-scale totals, and early experiments that do not yet have stable types remain jobs for the tools built for those jobs. An automation platform can still knock on the door: an outside event can start a sequence when the next step depends on what the record *is* and what it is linked to. A vector index can still answer "what sounds alike" over text that was never a record.

## What to remember

pona flow excels when the work is routine and the context is not. The checklist repeats. The people, the links, the services, and the late-arriving facts do not. Put the meaning, the records, and the route in one room, let every door start the same run, and keep the number from the coat check until the missing piece shows up.

The pictures in this note live beside their one-line captions in [VISUALS.md](VISUALS.md). The agency cut, which stays on the pain and where pona flow sits, is [video/AGENCY-PITCH.md](video/AGENCY-PITCH.md). The technical cut of this Monday is [video/TECHNICAL-PITCH.md](video/TECHNICAL-PITCH.md), with the video at [video/technical-pitch.mp4](video/technical-pitch.mp4). The engineer-facing skim is [5-MINUTE-ARCHITECTURE.md](5-MINUTE-ARCHITECTURE.md). The longer comparison with the tools teams usually stitch together is [WHY-PONA-FLOW.md](WHY-PONA-FLOW.md).
