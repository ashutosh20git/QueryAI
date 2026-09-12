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
| `QueryAI-org/QueryAI` | public     | release binaries, the install script, user README |

`QueryAI-dist` also carries two orphan branches the CLI reads at runtime:

| Branch    | File          | Consumed by                                  |
| --------- | ------------- | -------------------------------------------- |
| `catalog` | `api.json`    | `ModelsDev.MIRROR_SOURCE` — backup catalog   |
| `schema`  | `config.json` | `ConfigV1.SCHEMA_URL` — editor config schema |

Four places must agree on the distribution repo name. They all default to
`QueryAI-org/QueryAI`, and all read a `DIST_REPO` variable or equivalent
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

### 3. Optional — the `RELEASE_PAT` secret

Only needed for the pull-request release flow below. `release-pr.yml` opens a
pull request, and GitHub deliberately does not run workflows for events created
with the built-in `GITHUB_TOKEN` — so with the default token that pull request
arrives with no checks at all and can never show as accepted. A personal access
token makes the checks run.

1. <https://github.com/settings/personal-access-tokens/new>
2. Resource owner: your account. Repository access: **only** `QueryAI`.
3. Repository permissions: **Contents → Read and write**, **Pull requests →
   Read and write**, **Workflows → Read and write**.

```bash
gh secret set RELEASE_PAT --repo ashutosh20git/QueryAI
```

Without it `release-pr.yml` still opens the pull request, you just have to push
an empty commit to it (or close and reopen it) to make CI run.

### 4. Optional — override the distribution repo

Only if you rename or move it:

```bash
gh variable set DIST_REPO --repo ashutosh20git/QueryAI --body "youruser/YourDist"
```

### 5. Verify the setup

```bash
gh secret list --repo ashutosh20git/QueryAI
```

You should see `DIST_TOKEN`, plus `NPM_TOKEN` and `RELEASE_PAT` if you set them
up.

---

## Cutting a release

There are two ways in. The **pull-request flow** is the normal one: it puts a
reviewable version bump in front of you and runs the full merge gate against it
before anything ships. The **direct dispatch** underneath is for rehearsals and
for re-running a release that half-failed.

### The pull-request flow

```
release-pr.yml  ──►  release/vX.Y.Z PR  ──►  merge  ──►  release-merge.yml  ──►  release.yml
   dispatch          CI runs on it        (approval)      tags the commit        builds + publishes
```

**1. Open the release pull request.**

```bash
gh workflow run release-pr --repo ashutosh20git/QueryAI -f bump=patch
```

`bump` is `patch`, `minor` or `major`. To pin an exact version instead, pass
`-f version=0.1.0` (no leading `v`) and the bump is ignored.

The job bumps `packages/queryai/package.json` and `packages/sdk/js/package.json`,
prepends the commit subjects since the last `v*` tag to `CHANGELOG.md`, pushes
`release/vX.Y.Z` and opens a pull request labelled `release`. Re-running it for
the same version updates that branch and pull request rather than failing.

**2. Review it, and let the gate judge it.**

`ci.yml` runs on the pull request like any other. `ci-ok` going green is what
"this release is safe to ship" means — see [`.github/CI.md`](.github/CI.md).
Read the changelog while you wait; it is the release notes users will see.

**3. Merge it.**

Merging is the approval, and the only manual step. `release-merge.yml` fires on
the merge, tags the merge commit `vX.Y.Z`, and dispatches `release.yml` with that
version. Nothing is published until then, so an abandoned release pull request
costs nothing but a branch.

**4. Watch the release.**

```bash
gh run watch --repo ashutosh20git/QueryAI
```

`release.yml` creates the release on `QueryAI-dist`, cross-compiles all twelve
targets from one Linux runner, uploads the archives, asserts the release actually
has assets, and — if `NPM_TOKEN` is set — publishes to npm under the `latest`
tag.

### Direct dispatch

`release.yml` is still dispatchable on its own. Use it to rehearse, or when a
release already has its tag and only the build needs re-running:

```bash
gh workflow run release --repo ashutosh20git/QueryAI -f version=0.1.0
gh workflow run release --repo ashutosh20git/QueryAI -f version=0.1.0 -f draft=true
```

It builds from whatever is on the default branch, so anything unpushed will not
be in the release, and it neither bumps a version nor writes a tag — that is what
the pull-request flow adds. `draft=true` rehearses without publishing anything
publicly. Re-running for an existing version reuses that release and re-uploads
the assets, so a failed run is safe to retry.

### Verify what users will get

```bash
gh release view v0.1.0 --repo QueryAI-org/QueryAI
curl -fsSL https://raw.githubusercontent.com/QueryAI-org/QueryAI/main/install | bash
queryai --version
npm view queryai version      # only if you wired up npm
```

---

## The mirrors

Two scheduled workflows keep `QueryAI-dist` current. Both need `DIST_TOKEN`.

| Workflow      | Runs                                 | Publishes        |
| ------------- | ------------------------------------ | ---------------- |
| `catalog.yml` | daily at 05:17 UTC, or on dispatch   | `catalog` branch |
| `schema.yml`  | on pushes touching the config schema | `schema` branch  |

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
  `github.repository == 'QueryAI-org/QueryAI'` and it expects Blacksmith runners
  plus AUR, Homebrew, Docker and SST credentials. `release.yml` replaces the part
  that matters; the rest was left rather than half-migrated.
- **Windows code signing** — needs a certificate. Until then Windows users get a
  SmartScreen warning, which the user README explains.
- **Desktop app releases** — `packages/desktop` is not built by `release.yml`.
- **Homebrew, AUR, Docker, Scoop** — no taps or images are published.
