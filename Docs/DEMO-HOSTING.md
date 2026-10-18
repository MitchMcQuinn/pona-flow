# Moved: cloud self-host installer

We are **not** running a shared public demo (one Neo4j for every visitor). Identical
attributive labels would collide across users and look like product bugs.

| Edition | What it is |
|---------|------------|
| **Community** (free) | Clone / fork the repo; host locally or with Docker yourself. [SELF-HOSTING.md](SELF-HOSTING.md), [FIRST-TIME-SETUP.md](FIRST-TIME-SETUP.md) |
| **Self-hosted** (free) | Terminal installer: your Fly.io app + your Aura DB (+ optional Clerk). [Setup](https://mitchmcquinn.github.io/pona-flow/wizard.html) · [`scripts/fly-setup.sh`](../scripts/fly-setup.sh) |
| **Hosted** (paid) | We provision app + DB + auth for you. **Coming soon.** |

The [`fly.toml`](../fly.toml) in this repo is a **template** for edition 2, not a shared sandbox. Every push to `main` publishes `ghcr.io/mitchmcquinn/pona-flow:main`. Instance admins can review those commits and roll forward from the gear menu when a Fly deploy token is configured.
