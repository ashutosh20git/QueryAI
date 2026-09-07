# QueryAI — distribution

Public distribution point for [QueryAI](https://github.com/ashutosh20git/QueryAI),
an AI coding agent. This repository carries **release artifacts only** — the
source is maintained privately.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/ashutosh20git/QueryAI-dist/main/install | bash
```

Binaries for each supported platform are attached to every
[release](https://github.com/ashutosh20git/QueryAI-dist/releases).

## What else lives here

Two orphan branches serve data the CLI reads at runtime. They are generated, not
written by hand:

| Branch    | File          | Purpose                                                              |
| --------- | ------------- | -------------------------------------------------------------------- |
| `catalog` | `api.json`    | Daily mirror of the [models.dev](https://models.dev) catalog, used as a backup when models.dev cannot be reached. |
| `schema`  | `config.json` | JSON Schema for `queryai.json`, so editors validate config files.     |

## License

QueryAI is MIT licensed. It is derived from
[opencode](https://github.com/anomalyco/opencode), whose copyright notice is
retained in `LICENSE` alongside the notice for subsequent modifications. The
MIT terms travel with these binaries; see `LICENSE` for the full text.
