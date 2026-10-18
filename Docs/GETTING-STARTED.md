# Getting Started with pona flow

Welcome! This guide is for **people who want to use pona flow**, not necessarily people
who build or host it. If you're evaluating the product, onboarding a team, or opening your
instance for the first time, start here.

For technical deployment (servers, databases, backups), see
[DEPLOYMENT.md](DEPLOYMENT.md) and [OPERATOR-BACKUP.md](OPERATOR-BACKUP.md).

---

## What is pona flow?

pona flow is a **workspace for designing and running structured workflows** on your data.

Think of it as a place where you can:

- Organize work into **spaces** (separate environments — like projects or departments).
- Define **sequences** (step-by-step automations you can run when you need them).
- Build and connect **schemas** (the shape of your information) and **instances** (the actual
  records).

Each organization runs its **own private copy** of the application. Your data stays yours;
it is not mixed with anyone else's.

---

## How to get an instance

| Edition | How |
|---------|-----|
| **Community** (free) | Clone or fork [the GitHub repo](https://github.com/MitchMcQuinn/pona-flow); host with Docker yourself ([SELF-HOSTING.md](SELF-HOSTING.md)). |
| **Self-hosted** (free) | Use the [cloud setup wizard](https://mitchmcquinn.github.io/pona-flow/wizard.html) for Fly.io + Neo4j Aura (+ optional Clerk). |
| **Hosted** (paid) | Coming soon — we run app + database + sign-in for you. |

There is no shared public demo: each deployment has its own Neo4j database.

---

## What you'll receive when you're onboarded

Before your first login, you should get this from whoever set up the instance:

| What you get | What it's for |
|--------------|---------------|
| **Your instance URL** | The web address where you open pona flow (for example `http://localhost:8765` on the installer's own machine, or `https://flow.your-company.com`) |
| **An invitation** | Your email address added to a space by its admin, so you can create an account |
| **A designated owner** | The person who ran the setup page is the **instance admin** — usually the installer or a project lead |

If anything on that list is missing, ask your admin before you rely on the instance for
real work.

---

## Your first five minutes (step by step)

### Step 1 — Open your instance

1. Open the URL you were given in your browser.
2. You will see either **Set up pona flow** (only on a brand-new instance, for the very first
   person) or **Sign in**.

> **Tip:** Bookmark this URL. It's the front door to your private workspace.

### Step 2 — Create your account or sign in

- **First person on a new instance:** fill in the setup page (email, display name, a
  password of at least 10 characters). That account becomes the **instance admin**. If
  you're setting up for your organization, make sure the right person does this.
- **Everyone else:** click **Create an account** on the sign-in page and use the email
  address your admin invited. If the page says sign-up is by invitation, ask a space
  admin to invite you first.
- **Returning:** sign in with your email and password. You stay signed in on that browser
  for 30 days.

You won't see the main dashboard until you're signed in.

### Step 3 — Create your first space

When you arrive, the app may ask you to **create a space** before you can do anything else.
A space is your working environment — like opening a new project folder.

1. Enter a **name** for your space (letters, numbers, and spaces only — e.g. `Marketing` or
   `Client Alpha`).
2. Click **Create**.

You become the **owner** of that space automatically. Anyone else who needs access will need
to be invited as a member (see "Working with your team" below).

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

- **Left — Navigation:** pick your space and browse **sequences**. One-step and multi-step
  workflows share one list; multi-step sequences are marked with an icon.
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
| **Sequence** | A workflow you can run. Some have many steps (marked with an icon in the nav); some have one |
| **Step** | One action inside a sequence (read data, call an API, branch on a condition, etc.) |
| **Schema** | A template describing what kind of data something is |
| **Instance (data)** | An actual record that follows a schema (e.g. a specific company or person) |
| **Builder** | The tool on the right where you design queries and workflows |
| **Member** | Someone who has been given access to a space |
| **Owner** | The person who created a space; has full control within it |
| **Admin** | The instance-wide manager (created on the setup page); can access advanced maintenance tools |

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

Every instance comes with a graph database already connected (the installer set it up).
Pointing a particular space at a different database is an admin task done at the **space**
level — not something most end users touch. If runs fail with database errors, contact
whoever manages your instance.

---

## Working with your team

Access works like this:

- **Spaces are private by membership.** If you're not a member of a space, you won't see it
  in your list.
- **Creating a space makes you its owner** with full access inside that space.
- **Inviting people:** open the space's **Users** panel and enter a colleague's email and
  role. They then open the instance URL, choose **Create an account**, and sign up with that
  email; the invitation is applied automatically. Roles (**Member** and **Admin** out of the
  box; admins can define more) control what they can do inside the space.

If a colleague can't see a space you created, they likely haven't been invited yet, or
signed up with a different email than the one you invited.

---

## What's included

Everything in the self-hosted product is included: accounts and sign-in, spaces, membership
with roles, the builder, running sequences, the audit log, credentials, and the **agent /
MCP gateway** that lets AI tools call your sequences with their own keys. The installer
can optionally switch sign-in to a corporate identity provider (Clerk); ask your admin if
your organization uses that.

---

## Troubleshooting (quick answers)

**I can't sign in.**  
Check that you're using the correct instance URL and the email you were invited with. After
several wrong attempts sign-in pauses for a few minutes. If you've forgotten your password,
your instance admin can reset it for you (there is no self-service reset email yet).

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

- Your instance is **yours**. Data is stored in databases on the machine your organization
  chose, not pooled with anyone else.
- Passwords are stored only as salted hashes; nobody, including the admin, can read them.
- When your instance is reached over the internet it should show the padlock (HTTPS); the
  install guide covers how. On a single machine (`localhost`) there is no padlock, and that
  is expected.
- Sign-in, TLS, and instance isolation are described for operators in [DEPLOYMENT.md](DEPLOYMENT.md).

---

## Where to go from here

| If you want to… | Read… |
|-----------------|-------|
| Understand the pains pona flow solves, and how it compares to alternatives | [WHY-PONA-FLOW.md](WHY-PONA-FLOW.md) |
| Install an instance for your team | [SELF-HOSTING.md](SELF-HOSTING.md) |
| Operate an instance (proxy, secrets, auth options) | [DEPLOYMENT.md](DEPLOYMENT.md) |
| Back up and restore an instance | [OPERATOR-BACKUP.md](OPERATOR-BACKUP.md) |
| Develop or customize the product | [FIRST-TIME-SETUP.md](FIRST-TIME-SETUP.md) then [README.md](../README.md) |

---

## Getting help

Your first point of contact is whoever installed your instance (internal IT or the
colleague who ran the setup). For bugs in the product itself, open an issue at
<https://github.com/MitchMcQuinn/pona-flow/issues>. Have ready:

- Your instance URL
- The email you use to sign in
- What you were trying to do, and any error message on screen

We're glad you're here — take it one space and one sequence at a time.
