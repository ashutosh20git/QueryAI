<p align="center">
  <b>QueryAI</b><br>
  An AI coding agent for the terminal that runs on free models, remembers you between sessions, and needs no account.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> &middot;
  <a href="#free-models-and-fallback">Free models</a> &middot;
  <a href="#memory">Memory</a> &middot;
  <a href="#what-this-fork-changes">What this fork changes</a> &middot;
  <a href="#credits-and-licence">Licence</a>
</p>

---

QueryAI is a fork of [opencode](https://github.com/anomalyco/opencode) built around
three ideas:

- **Free models first.** Bring your own keys — most providers have a free tier —
  and QueryAI ranks free, tool-capable models ahead of paid ones.
- **It keeps going when a free tier runs out.** Hit a quota ceiling and the turn
  moves to another model on a different key, mid-session, without failing.
- **It remembers you, locally.** Durable facts persist across sessions in a file
  on your machine. No account, no server, no API key.

It runs entirely on your machine against your own provider credentials. Nothing
is uploaded anywhere unless you explicitly turn on sharing and point it at a
server you run.

---

## Quick start

**Using QueryAI?** You do not need this repository. Install a release and follow
the setup guide at
[ashutosh20git/QueryAI-dist](https://github.com/ashutosh20git/QueryAI-dist):

```bash
curl -fsSL https://raw.githubusercontent.com/ashutosh20git/QueryAI-dist/main/install | bash
# or
npm install -g queryai
```

**Working on QueryAI?** This repo is the source. Requires [Bun](https://bun.sh):

```bash
git clone https://github.com/ashutosh20git/QueryAI
cd QueryAI
bun install
bun run dev
```

Cutting a release is documented in [RELEASING.md](RELEASING.md).

Add a provider credential (any of them; the free tiers are the point):

```bash
bun run dev providers   # interactive login for openrouter, google, groq, nvidia, …
```

Then pick a free model and go:

```bash
bun run dev models                                   # list what your keys unlock
bun run dev run -m nvidia/moonshotai/kimi-k3 "explain this repo"
```

Set a default so you do not pass `-m` every time:

```json title="~/.config/queryai/queryai.json"
{
  "$schema": "https://raw.githubusercontent.com/ashutosh20git/QueryAI-dist/schema/config.json",
  "model": "nvidia/moonshotai/kimi-k3",
  "memory": { "auto_capture": true }
}
```

---

## Free models and fallback

When a model is rate limited or its key is out of quota, the turn is re-run on
another model instead of failing. Two rules make that safe:

- **Free models rank first**, ordered among themselves by capability. A switch
  always lands on a different provider's key than the one that just failed.
- **A fallback never costs more than the model you chose.** Start free and the
  session stays free; when the free options are exhausted the turn fails rather
  than quietly moving onto a metered key. `fallback.max_cost` overrides this.

A model set aside for a plain rate limit is retried after five minutes; one that
hit a quota ceiling after an hour. Bare `403`s are treated as auth failures and
surfaced, not worked around.

See [the fallback docs](packages/web/src/content/docs/config.mdx) for the knobs.

---

## Memory

On by default, stored in a JSON file under your data directory, mode `0600`.
Nothing leaves the machine and there is no quota.

The agent gets a `memory` tool (`remember`, `search`, `list`, `forget`), and
relevant memories are injected into the system prompt at the start of each turn.
Facts are project-scoped by default; `user` scope follows you everywhere.

Be aware of what that means: what you tell the agent to remember is written to
disk in readable form, and `memory.auto_capture` sends each completed turn to the
store. Turn it off with `"memory": { "enabled": false }`.

Set `MEM0_API_KEY` to use [mem0](https://mem0.ai) instead, which adds LLM
extraction, embedding search and sync across devices.

---

## Sharing (optional, and yours)

`queryai share` is **off until you configure it**. There is no default server,
because publishing a conversation to a host you did not choose is not a sensible
default.

To turn it on, deploy [`packages/share-worker`](packages/share-worker) to your own
Cloudflare account — one worker, one R2 bucket, free tier, no domain needed — and
set `share_url`. Shared sessions then live entirely on infrastructure you control.

---

## What this fork changes

Beyond the branding, relative to upstream opencode:

| Area              | Change                                                                                |
| ----------------- | ------------------------------------------------------------------------------------- |
| Memory            | New. Local file backend by default; mem0 optional                                     |
| Fallback          | New. Free-first ranking, per-session cooldowns, a price ceiling                       |
| Sharing           | No default server; deploy your own worker                                             |
| Updates           | Points at the QueryAI-dist releases, not upstream's                                   |
| Model catalog     | models.dev, with a daily mirror in QueryAI-dist as the backup                          |
| Config `$schema`  | Generated from this repo's config, published to QueryAI-dist `schema`                 |
| Accounts, billing | Removed. No hosted console, no subscription gateway                                   |
| GitHub agent      | Removed. It depended on an app we do not own                                          |

The only network traffic is to your own model providers, the public model
catalog at [models.dev](https://models.dev) (mirrored into QueryAI-dist as a
backup), the distribution repo for upgrades, and — if you configure it — your own
share worker. No server belonging to another project is contacted for anything
that carries your code or conversations.

---

## Development

```bash
bun install
bun run dev                       # run the TUI from source
bun run typecheck                 # all packages
bun test --cwd packages/queryai   # or packages/core
bun run lint
```

---

## Credits and licence

QueryAI is a fork of [opencode](https://github.com/anomalyco/opencode) by
anomalyco, and would not exist without it. Upstream did the hard work of building
the agent loop, the provider layer, the TUI and the plugin system; this fork
changes what it points at and adds memory and model fallback on top.

MIT, and the upstream copyright notice is retained in [LICENSE](LICENSE) as MIT
requires.

- Original work: Copyright (c) 2025 opencode
- Modifications: Copyright (c) 2026 Ashutosh
