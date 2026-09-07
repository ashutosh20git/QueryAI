# Releasing QueryAI

How a release gets from this repository into users' hands, and the one-time setup
that makes it possible.

## How distribution is arranged

This repository is **private**. GitHub release assets inherit their repository's
visibility, so releases published here would be downloadable only by people who
can already read the source — which is nobody but you. Distribution therefore
goes through a second, **public** repository that holds artifacts and no source:

| Repository                   | Visibility | Holds                                             |
| ---------------------------- | ---------- | ------------------------------------------------- |
| `ashutosh20git/QueryAI`      | private    | the source (this repo)                            |
| `ashutosh20git/QueryAI-dist` | public     | release binaries, the install script, user README |

`QueryAI-dist` also carries two orphan branches the CLI reads at runtime:

| Branch    | File          | Consumed by                                  |
| --------- | ------------- | -------------------------------------------- |
| `catalog` | `api.json`    | `ModelsDev.MIRROR_SOURCE` — backup catalog    |
| `schema`  | `config.json` | `ConfigV1.SCHEMA_URL` — editor config schema  |

Four places must agree on the distribution repo name. They all default to
`ashutosh20git/QueryAI-dist`, and all read a `DIST_REPO` variable or equivalent
override:

- `packages/core/src/models-dev.ts` — `MIRROR_SOURCE`
- `packages/core/src/v1/config/config.ts` — `SCHEMA_URL`
- `packages/queryai/src/installation/index.ts` — `Release.repo`
- `install` — `REPO`

---

## One-time setup

### 1. Create the `DIST_TOKEN` secret

The built-in `GITHUB_TOKEN` is scoped to the repository running the workflow, so
it cannot write to `QueryAI-dist`. Create a fine-grained personal access token:

1. <https://github.com/settings/personal-access-tokens/new>
2. Resource owner: your account. Repository access: **only** `QueryAI-dist`.
3. Repository permissions: **Contents → Read and write**.
4. Copy the token.

Then add it to this repository:

```bash
gh secret set DIST_TOKEN --repo ashutosh20git/QueryAI
# paste the token when prompted
```

### 2. Optional — publish to npm

Skip this and releases still ship binaries through the install script; you just
do not get `npm i -g queryai`.

```bash
npm login
npm token create --read-only=false     # copy the token
gh secret set NPM_TOKEN --repo ashutosh20git/QueryAI
```

### 3. Optional — override the distribution repo

Only if you rename or move it:

```bash
gh variable set DIST_REPO --repo ashutosh20git/QueryAI --body "youruser/YourDist"
```

### 4. Verify the setup

```bash
gh secret list --repo ashutosh20git/QueryAI
```

You should see `DIST_TOKEN`, and `NPM_TOKEN` if you set it up.

---

## Cutting a release

### 1. Make sure the branch is green

```bash
bun install
bun run typecheck
bun test --cwd packages/core
bun test --cwd packages/queryai
```

### 2. Push your work

```bash
git push origin dev
```

The workflow builds from what is on the branch, so anything unpushed will not be
in the release.

### 3. Run the release workflow

```bash
gh workflow run release --repo ashutosh20git/QueryAI -f version=0.1.0
```

Use a plain semver string with no leading `v`. To rehearse without publishing
anything publicly, add `-f draft=true`.

Watch it:

```bash
gh run watch --repo ashutosh20git/QueryAI
```

The workflow creates the release on `QueryAI-dist`, cross-compiles all twelve
targets from one Linux runner, uploads the archives, asserts the release actually
has assets, and — if `NPM_TOKEN` is set — publishes to npm under the `latest`
tag.

### 4. Verify what users will get

```bash
gh release view v0.1.0 --repo ashutosh20git/QueryAI-dist
curl -fsSL https://raw.githubusercontent.com/ashutosh20git/QueryAI-dist/main/install | bash
queryai --version
npm view queryai version      # only if you wired up npm
```

---

## The mirrors

Two scheduled workflows keep `QueryAI-dist` current. Both need `DIST_TOKEN`.

| Workflow      | Runs                                   | Publishes                |
| ------------- | -------------------------------------- | ------------------------ |
| `catalog.yml` | daily at 05:17 UTC, or on dispatch     | `catalog` branch         |
| `schema.yml`  | on pushes touching the config schema   | `schema` branch          |

Run either by hand:

```bash
gh workflow run catalog --repo ashutosh20git/QueryAI
gh workflow run schema  --repo ashutosh20git/QueryAI
```

Neither is on the critical path for a release. The catalog mirror is only a
backup — the CLI reads models.dev first — and a stale schema affects editor
autocompletion, not the CLI.

---

## Local builds

Build every target the release builds:

```bash
./packages/queryai/script/build.ts
```

Just your own platform, which is much faster:

```bash
QUERYAI_VERSION=0.0.0-dev ./packages/queryai/script/build.ts --single --skip-embed-web-ui
./packages/queryai/dist/queryai-*/bin/queryai --version
```

Inspect what would be published to npm without publishing it:

```bash
./packages/queryai/script/publish-npm.ts --dry-run
```

Note that `build.ts` runs `bun add` for platform-specific optional dependencies,
which dirties `bun.lock` and re-sorts `packages/queryai/package.json`. Revert
both before committing:

```bash
git checkout -- bun.lock packages/queryai/package.json
```

---

## Licensing

QueryAI is MIT and derived from opencode. MIT permits keeping this source private
and distributing only binaries, but it requires the copyright notice to travel
with every copy. Since users never see this repository, the notice has to ride
along with the artifacts, and it does:

- `build.ts` copies `LICENSE` into every release archive
- `publish-npm.ts` copies `LICENSE` into the npm tarball
- `QueryAI-dist` carries `LICENSE` at its root

If you change how artifacts are produced, keep that true.

---

## What is deliberately not wired up

- **`publish.yml`** — the upstream workflow. Every job is gated on
  `github.repository == 'anomalyco/opencode'` and it expects Blacksmith runners
  plus AUR, Homebrew, Docker and SST credentials. `release.yml` replaces the part
  that matters; the rest was left rather than half-migrated.
- **Windows code signing** — needs a certificate. Until then Windows users get a
  SmartScreen warning, which the user README explains.
- **Desktop app releases** — `packages/desktop` is not built by `release.yml`.
- **Homebrew, AUR, Docker, Scoop** — no taps or images are published.
