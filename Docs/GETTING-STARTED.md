# Getting Started with pona flow

Welcome! This guide is for **people who want to use pona flow**, not necessarily people
who build or host it. If you're evaluating the product, onboarding a team, or opening your
instance for the first time, start here.

For technical deployment (servers, databases, security configuration), see
[DEPLOYMENT.md](DEPLOYMENT.md). For a plain-English explanation of how security works, see
[SECURITY-GUIDE.md](SECURITY-GUIDE.md).

---

## What is pona flow?

pona flow is a **workspace for designing and running structured workflows** on your data.

Think of it as a place where you can:

- Organize work into **spaces** (separate environments — like projects or departments).
- Define **sequences** (step-by-step automations you can run when you need them).
- Build and connect **schemas** (the shape of your information) and **instances** (the actual
  records).

Each customer receives their **own private copy** of the application. Your data stays yours;
it is not mixed with anyone else's.

---

## Two ways to use pona flow

### Option A — Managed hosting (most common)

You receive a **ready-to-use web address** (for example, `https://your-company.pona-flow.example`).
We set up the servers, security, backups, and updates. You sign in and start working.

**You need:** a modern web browser (Chrome, Firefox, Safari, or Edge) and an account we
create or invite you to.

**You do not need:** to install software, run commands, or manage servers.

### Option B — Self-hosted (technical teams)

Your organization runs pona flow on its own infrastructure. This path is for teams with
someone comfortable managing servers, databases, and login configuration.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the operator checklist.

---

## What you'll receive when you're onboarded (managed hosting)

Before your first login, you should get something like this from your provider:

| What you get | What it's for |
|--------------|---------------|
| **Your instance URL** | The web address where you open pona flow |
| **Login instructions** | How to sign in (email/password, Google, Microsoft, etc.) |
| **A designated owner account** | The first person to sign in becomes the **instance admin** — usually you or your project lead |
| **Optional: Neo4j / data connection details** | Only if you're connecting your own graph database; often handled entirely for you |

If anything on that list is missing, ask your provider before you rely on the instance for
real work.

---

## Your first five minutes (step by step)

### Step 1 — Open your instance

1. Open the URL you were given in your browser.
2. You should see a **sign-in screen** (handled by our login partner, Clerk — it may show
   your company name or pona flow branding).

> **Tip:** Bookmark this URL. It's the front door to your private workspace.

### Step 2 — Sign in

1. Create an account or sign in with the method you were given (email, Google, etc.).
2. The **first person** to sign in on a brand-new instance automatically becomes the
   **instance admin**. If you're setting up for your organization, make sure the right
   person signs in first.

You won't see the main dashboard until you're signed in.

### Step 3 — Create your first space

When you arrive, the app may ask you to **create a space** before you can do anything else.
A space is your working environment — like opening a new project folder.

1. Enter a **name** for your space (letters, numbers, and spaces only — e.g. `Marketing` or
   `Client Alpha`).
2. Click **Create**.

You become the **owner** of that space automatically. Anyone else who needs access will need
to be added as a member (see "Working with your team" below).

### Step 4 — Explore the dashboard

Once a space exists, you'll see three main areas:

```text
┌─────────────────────────────────────────────────────────────┐
│  Top bar — Run sequences, switch back to the builder        │
├──────────────┬──────────────────────────┬───────────────────┤
│  Navigation  │  Visualization           │  Config / Builder   │
│  (spaces,    │  (graphs and results)    │  (edit workflows, │
│   sequences) │                          │   set parameters) │
└──────────────┴──────────────────────────┴───────────────────┘
```

- **Left — Navigation:** pick your space and browse **sequences**. Multi-step workflows sit
  under Sequences; a single runnable step sits under **Single-step**. Both are sequences.
- **Center — Visualization:** see how a sequence is structured, or view results after a run.
- **Right — Config / Builder:** build new queries, fill in parameters, or inspect details.

### Step 5 — Run your first sequence (when one is available)

1. In the left panel, select a **sequence** under your space.
2. If the sequence needs inputs, the right panel will ask for **parameters** — fill them in.
3. Click **Run Sequence** in the top bar.
4. Results appear in the center panel (as a graph, table, or text response depending on the
  workflow).

If you don't see any sequences yet, that's normal on a fresh instance — you or your admin
may need to build them first (see "Common next steps" below).

---

## Key ideas (in everyday language)

| Term | Plain meaning |
|------|----------------|
| **Instance** | Your organization's private copy of pona flow |
| **Space** | A workspace / project environment inside your instance |
| **Sequence** | A workflow you can run. Some have many steps; some have one (listed under **Single-step**) |
| **Step** | One action inside a sequence (read data, call an API, branch on a condition, etc.) |
| **Schema** | A template describing what kind of data something is |
| **Instance (data)** | An actual record that follows a schema (e.g. a specific company or person) |
| **Builder** | The tool on the right where you design queries and workflows |
| **Member** | Someone who has been given access to a space |
| **Owner** | The person who created a space; has full control within it |
| **Admin** | The instance-wide manager (first login); can access advanced maintenance tools |

You don't need to memorize these on day one. They become familiar as you use the app.

---

## Common next steps after setup

### Create another space

Use the **+** or **create space** control in the navigation panel when you need a separate
environment (e.g. one space per client or per internal team).

### Edit a space

Open the space menu and choose **edit** to change its name or optional webhook endpoint.

### Build a new workflow

1. Select a space.
2. Open the **builder** on the right (or use "Back to builder" in the top bar).
3. Design a query or sequence and save it to the catalog.

Building workflows has a learning curve. Start with a new sequence in the builder and
customize over time.

### Connect external data (Neo4j)

If your workflows use a graph database, connection details are configured at the **space**
level by your admin or hosting provider — not something most end users touch daily. If runs
fail with database errors, contact whoever manages your instance.

---

## Working with your team

Today, access works like this:

- **Spaces are private by membership.** If you're not a member of a space, you won't see it
  in your list.
- **Creating a space makes you its owner** with full access inside that space.
- **Adding other people** to a space (so they can see and use it) is handled through your
  instance admin or hosting provider during early rollout — fine-grained "invite by email"
  self-service may expand in future releases.

If a colleague can't see a space you created, they likely haven't been added as a member yet.

---

## What's included vs. what may be a paid upgrade

The core product includes sign-in, spaces, membership, building workflows, and running
sequences on **your own dedicated instance**.

Some organizations later add **commercial** capabilities, such as:

- **Single sign-on (SSO)** — log in with your company's corporate identity system
- **Audit logs** — detailed records of who did what, for compliance
- **Advanced roles** — finer control than "member or not" (viewer, editor, etc.)
- **Agent / MCP gateway** — let AI tools call your sequences safely

If you're unsure what's included in your plan, ask your provider.

---

## Troubleshooting (quick answers)

**I can't sign in.**  
Check that you're using the correct instance URL. Try password reset or the sign-in method
you were told to use (Google, email, etc.). Contact your admin if your account wasn't
provisioned yet.

**I see a blank page after sign-in.**  
Try a hard refresh (Ctrl+Shift+R or Cmd+Shift+R). If it persists, your instance may still be
starting up — wait a minute and try again, or contact support.

**I'm asked to create a space and can't skip it.**  
That's intentional on a new instance — you need at least one space to work. Create one with
any name; you can rename or add more later.

**I don't see any sequences.**  
Sequences must exist in the catalog and be **shared with your space** (via space labels) or
built in the builder. A fresh instance often starts empty except for system templates.

**Something failed when I ran a sequence.**  
Note the error message, which step you were on, and what parameters you entered. Share that
with your admin — it often points to missing data, a misconfigured connection, or a
parameter that wasn't filled in.

**I get "You do not have access to this space."**  
You're signed in, but you're not a member of that space. Ask the space owner or instance admin
to add you.

---

## Privacy and data ownership (short version)

- Your instance is **yours**. Data is stored in databases tied to your instance, not pooled
  with other customers.
- You sign in through a **professional login service**; pona flow does not store your
  password.
- Traffic to your instance is **encrypted** in transit (the padlock in your browser).
- For more detail, see [SECURITY-GUIDE.md](SECURITY-GUIDE.md).

---

## Where to go from here

| If you want to… | Read… |
|-----------------|-------|
| Understand security in plain language | [SECURITY-GUIDE.md](SECURITY-GUIDE.md) |
| Deploy or operate an instance yourself | [DEPLOYMENT.md](DEPLOYMENT.md) |
| See why architectural choices were made | [DECISIONS.md](DECISIONS.md) |
| Develop or customize the product | [FIRST-TIME-SETUP.md](FIRST-TIME-SETUP.md) then [README.md](../README.md) |

---

## Getting help

For **managed hosting**, your first point of contact is whoever provisioned your instance
(your pona flow provider or internal IT). Have ready:

- Your instance URL
- The email you use to sign in
- What you were trying to do, and any error message on screen

We're glad you're here — take it one space and one sequence at a time.
