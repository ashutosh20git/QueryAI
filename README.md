<p align="center">
  <b>QueryAI</b><br>
  An AI coding agent for the terminal that runs on free models, remembers you
  between sessions, and needs no account.
</p>

<p align="center">
  <a href="#1-install">Install</a> &middot;
  <a href="#2-add-a-provider-key">Add a key</a> &middot;
  <a href="#3-first-run">First run</a> &middot;
  <a href="#4-set-a-default-model">Configure</a> &middot;
  <a href="#memory">Memory</a> &middot;
  <a href="#free-models-and-fallback">Fallback</a> &middot;
  <a href="#troubleshooting">Troubleshooting</a>
</p>

---

QueryAI runs entirely on your machine against your own provider credentials.
There is no account to create, no subscription, and nothing is uploaded
anywhere. Three things make it different from most terminal agents:

- **Free models first.** Bring your own keys — most providers have a free tier —
  and QueryAI ranks free, tool-capable models ahead of paid ones.
- **It keeps going when a free tier runs out.** Hit a quota ceiling and the turn
  moves to another model on a different key, mid-session, without failing.
- **It remembers you.** Durable facts persist across sessions in a file on your
  machine.

This repository holds the released binaries. The source is maintained privately.

---

## Requirements

- macOS, Linux, or Windows (x64 or arm64)
- [`ripgrep`](https://github.com/BurntSushi/ripgrep) is fetched automatically on first use — nothing to install by hand
- For the npm install route only: Node.js 18+

---

## 1. Install

Pick **one** of these.

### macOS / Linux — install script

```bash
curl -fsSL https://raw.githubusercontent.com/QueryAI-org/QueryAI/main/install | bash
```

This drops a single binary in `~/.queryai/bin` and adds it to your `PATH`. To
skip the `PATH` edit, append `-s -- --no-modify-path`.

### Any platform — npm

```bash
npm install -g queryai
```

`pnpm` and `yarn` work too. If you use `--ignore-scripts`, run the postinstall
by hand afterwards: `cd $(npm root -g)/queryai && node postinstall.mjs`.

### Windows — PowerShell

Use the npm route above, or download the `queryai-windows-x64.zip` asset from
[Releases](https://github.com/QueryAI-org/QueryAI/releases), unzip it, and
put `queryai.exe` somewhere on your `PATH`.

### Verify

```bash
queryai --version
```

If the command is not found, open a new terminal so the updated `PATH` is
picked up.

---

## 2. Add a provider key

QueryAI has no models of its own — it talks to providers using **your** keys.
Most have a free tier, which is the whole point of the fallback system.

Start the interactive login and pick a provider from the list:

```bash
queryai providers login
```

Good free-tier options to start with:

| Provider     | Where to get a key                                      | Notes                          |
| ------------ | ------------------------------------------------------- | ------------------------------ |
| Google       | [aistudio.google.com](https://aistudio.google.com/apikey) | Generous free tier, Gemini     |
| OpenRouter   | [openrouter.ai/keys](https://openrouter.ai/keys)         | Many `:free` models on one key |
| Groq         | [console.groq.com/keys](https://console.groq.com/keys)   | Very fast                      |
| NVIDIA       | [build.nvidia.com](https://build.nvidia.com)             | Large open models              |
| Cerebras     | [cloud.cerebras.ai](https://cloud.cerebras.ai)           | Very fast                      |

Add as many as you like — more keys means more room to fall back when one runs
out. Check what is configured:

```bash
queryai providers list
```

Keys are stored in `auth.json` under your data directory, readable only by you.
They are never sent anywhere except to that provider.

---

## 3. First run

See which models your keys actually unlock:

```bash
queryai models
```

Run a one-off prompt:

```bash
queryai run -m google/gemini-3.6-flash "explain what this repo does"
```

Or start the interactive terminal UI in the current directory:

```bash
queryai
```

Both read the files in your working directory, so `cd` into a project first.

---

## 4. Set a default model

So you stop passing `-m` every time. Create a config file:

**macOS / Linux:** `~/.config/queryai/queryai.json`
**Windows:** `%APPDATA%\queryai\queryai.json`

```json
{
  "$schema": "https://raw.githubusercontent.com/QueryAI-org/QueryAI/schema/config.json",
  "model": "google/gemini-3.6-flash"
}
```

The `$schema` line is optional but worth adding — editors will autocomplete and
validate every key from it.

For per-project settings, put a `queryai.json` in the project root instead. It
is merged over the global one.

---

## Memory

On by default. Durable facts are stored in a JSON file under your data
directory, mode `0600`. Nothing leaves the machine and there is no quota.

Just tell the agent to remember something:

```
> remember that I prefer pnpm over npm in this repo
```

It writes the fact and recalls it in later sessions automatically — relevant
memories are injected at the start of each turn, so you do not have to ask.

The agent has a `memory` tool with `remember`, `search`, `list` and `forget`.
Facts are project-scoped by default; `user` scope follows you everywhere.

**Be aware:** what you ask it to remember is written to disk in readable form.
To capture every finished turn automatically, or to turn memory off entirely:

```json
{
  "memory": {
    "enabled": true,
    "auto_capture": false
  }
}
```

To use [mem0](https://mem0.ai) instead of the local file — adding LLM extraction,
embedding search, and sync across devices — set `MEM0_API_KEY` in your
environment and it switches over automatically.

---

## Free models and fallback

When a model is rate limited or its key is out of quota, the turn is re-run on
another model instead of failing. Two rules keep that safe:

- **Free models rank first**, ordered among themselves by capability. A switch
  always lands on a different provider's key than the one that just failed.
- **A fallback never costs more than the model you chose.** Start free and the
  session stays free; when the free options are exhausted the turn fails rather
  than quietly moving you onto a metered key.

A model set aside for a plain rate limit is retried after five minutes; one that
hit a quota ceiling after an hour. A bare `403` is treated as an auth failure
and surfaced, not worked around — you need to know your key is broken.

Defaults are sensible, but you can pin the chain explicitly:

```json
{
  "fallback": {
    "enabled": true,
    "models": ["google/gemini-3.6-flash", "groq/llama-3.3-70b-versatile"],
    "max_switches": 3
  }
}
```

Set `"max_cost": 0` to keep a session on free models only, whatever it started
on.

---

## Everyday commands

```bash
queryai                        # interactive TUI in the current directory
queryai run "..."              # one-off prompt
queryai models                 # list models your keys unlock
queryai providers list         # show configured credentials
queryai session                # browse past sessions
queryai stats                  # token usage and cost
queryai upgrade                # update to the latest release
queryai uninstall              # remove the binary and its files
```

---

## Upgrading

```bash
queryai upgrade
```

It detects how you installed and uses the matching method. To pin a version:
`queryai upgrade 0.1.0`.

---

## Troubleshooting

**`queryai: command not found` after installing**
Open a new terminal. If it persists, add `~/.queryai/bin` to your `PATH`.

**`queryai models` lists nothing**
No credentials yet — run `queryai providers login`. The model list is filtered
to what your keys can actually reach.

**"This model is no longer available"**
Providers retire models. Run `queryai models` for the current list and update
your config.

**Everything fails with quota errors**
Every configured key is exhausted. Add another provider — fallback needs
somewhere to go. `queryai providers list` shows what you have.

**Windows SmartScreen warning**
The binaries are not code-signed yet. You can verify what you downloaded against
the checksums on the release, or install via npm instead.

**Sharing**
`queryai share` is off until you configure it — there is no default server,
because publishing a conversation to a host you did not choose is not a sensible
default.

---

## License

QueryAI is MIT licensed. It is a fork of
[opencode](https://github.com/anomalyco/opencode) by anomalyco, whose copyright
notice is retained in [LICENSE](LICENSE) alongside the notice for later
modifications, as MIT requires.

- Original work: Copyright (c) 2025 opencode
- Modifications: Copyright (c) 2026 Ashutosh

Upstream built the agent loop, the provider layer, the TUI and the plugin
system; this project changes what it points at and adds memory and model
fallback on top.
