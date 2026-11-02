# Editions

We are **not** running a shared public demo (one Neo4j for every visitor). Identical
attributive labels would collide across users and look like product bugs.

The front door is the guide chat. **Get started** is on the right of the top bar.

| Edition | What it is |
|---------|------------|
| **Local** | Fork the repo and host it yourself. [SELF-HOSTING.md](SELF-HOSTING.md), [FIRST-TIME-SETUP.md](FIRST-TIME-SETUP.md). Support is priced separately. |
| **Self-hosted** | Get started deploys into your Fly.io account and your Aura database. [`scripts/fly-setup.sh`](../scripts/fly-setup.sh) is the same deploy without the form. Support is priced separately. |
| **Hosted Basic** | We provision the app and Neo4j Community after a subscription. You can download the catalog and graph. |
| **Hosted Business** | Aura instead of Community. **Coming soon.** |
| **Sandbox** | The code `sandbox` starts a 7-day preview. A VIP code provisions hosting without a subscription. |

The [`fly.toml`](../fly.toml) in this repo is a **template** for self-hosted, not a shared sandbox. Every push to `main` publishes `ghcr.io/mitchmcquinn/pona-flow:main` and `ghcr.io/mitchmcquinn/pona-flow-hosted:main`.
