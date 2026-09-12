# Pending work

Written 2026-09-08, after `1e24e849`. Everything below is verified against the
repository and GitHub rather than assumed — where something is only known to be
true on Windows, it says so.

What is already done: the merge gate (`.github/workflows/ci.yml`), the release
flow (`release-pr.yml` → merge → `release-merge.yml` → `release.yml`), and the
two-repository distribution design. See [`.github/CI.md`](.github/CI.md) and
[`RELEASING.md`](RELEASING.md).

---

## 1. Blocking distribution — nothing reaches a user until these are done

### 1.1 Make `QueryAI-dist` public — done 2026-09-12

`QueryAI-org/QueryAI` is public and carries `main` (`LICENSE`,
`README.md`, `install`) plus the `catalog` and `schema` orphan branches the CLI
reads at runtime. All three raw URLs return 200.

The earlier `ashutosh20git/QueryAI-dist` was never a separate repository — the
name redirected to the source repo, so the split existed only in the code that
named it. Every reference now says `QueryAI-org/QueryAI`.

What this does **not** yet do: `QueryAI-org/QueryAI` is still public and still
holds the source. Making it private is deliberately held until 1.2 and 1.3
below prove the install path, because a private source repo cannot serve the
binaries or the runtime branches its own users need.

### 1.2 Create the `DIST_TOKEN` secret

There are currently **no secrets configured at all** on the source repo:

```bash
gh secret list --repo QueryAI-org/QueryAI   # empty
```

`release.yml` cannot write to `QueryAI-dist` without it — the built-in
`GITHUB_TOKEN` is scoped to the repository running the workflow. Setup steps are
in [`RELEASING.md`](RELEASING.md) § One-time setup.

### 1.3 Cut the first release

No releases exist on `QueryAI-dist` yet, so the pipeline has never run
end to end. Rehearse first, which publishes nothing publicly:

```bash
gh workflow run release --repo ashutosh20git/QueryAI -f version=0.1.0 -f draft=true
```

Then use the pull-request flow for the real one (`RELEASING.md` § Cutting a
release).

---

## 2. Blocking the merge gate — `ci-ok` cannot go green yet

### 2.1 Fourteen failing tests in `packages/core`

`bun turbo test` is the `unit` job. Running `packages/core` alone on Windows:
**1085 pass, 14 fail** in 482s. The failures:

| test                                                                                  | shape                             |
| ------------------------------------------------------------------------------------- | --------------------------------- |
| `NpmConfig.load` ×3, `NpmConfig.registry` ×2                                          | **deterministic, fails in ~25ms** |
| `Npm.add > reifies when package cache directory exists without the package installed` | fails at ~12s                     |
| `RepositoryCache` ×3                                                                  | 5s timeout                        |
| `SessionRunCoordinator > trampolines synchronous self-waking execution`               | 5s timeout                        |
| `Snapshot` ×3                                                                         | 5s timeout                        |
| `WebFetchTool > returns an error result when HTML-to-Markdown conversion throws`      | ~6.5s                             |

The `NpmConfig` group is the one to start on, because it is not a timing
problem. `NpmConfig.load(dir)` is not reading the project `.npmrc` at all —
given a tmpdir containing `registry=https://registry.example.test/`, it returns
the default `https://registry.npmjs.org/`, and scoped keys come back
`undefined`. Source is `packages/core/src/npm-config.ts`, which hands `cwd: dir`
to `@npmcli/config`; npm resolves a project `.npmrc` relative to `localPrefix`,
not `cwd`, and `localPrefix` is found by walking up for `package.json` or
`node_modules`. That is the likely cause and is **not yet confirmed**.

The rest are 5s timeouts around git and filesystem work, and the set that fails
**changes between runs** — under parallel `turbo` load, `@queryai/app` failed on
one run and `@queryai/core` on the next, while each passes when run alone. So
some of these are contention, not logic.

**Not yet known: whether any of this reproduces on Linux.** It has only been run
on Windows. The `unit` job runs both, so check the first `ci.yml` run on the
open pull request before spending time on a fix — the honest possibility is that
some of these are Windows-only and the Linux leg is already green.

### 2.2 The `e2e` job has never run

Playwright on Linux and Windows is in `ci.yml` and in `ci-ok`'s `needs:`, but no
run has ever exercised it. If it proves flaky, drop it from `ci-ok`'s `needs:`
rather than weakening the rule, so the gate keeps meaning something.

---

## 3. Turning "checks passed" into "cannot merge"

Passing checks stay advisory until a branch protection rule requires them, and
**branch protection is unavailable on a private repo on a free plan** — the API
returns `403 Upgrade to GitHub Pro or make this repository public`.

So this needs either GitHub Pro, or making the source repo public — which is a
separate decision from 1.1 and contradicts keeping the code private. Until one
of those, the gate is informational.

Once available: target `dev`, require a pull request, and add **`ci-ok`** as the
only required check. Full steps in [`.github/CI.md`](.github/CI.md).

---

## 4. Housekeeping

### 4.1 Cancel the stuck queued runs

Several runs have been queued for **18+ hours** waiting on
`blacksmith-4vcpu-ubuntu-2404`, a paid runner this account has no subscription
to. GitHub cancels them at 24 hours; cancelling by hand is tidier:

```bash
gh run list --repo ashutosh20git/QueryAI --status queued --limit 50
gh run cancel <id> --repo ashutosh20git/QueryAI
```

### 4.2 Sixteen workflows still request Blacksmith runners

`containers`, `docs-locale-sync`, `docs-update`, `duplicate-issues`, `generate`,
`nix-hashes`, `notify-discord`, `publish-github-action`, `publish-vscode`,
`publish`, `queryai`, `release-github-action`, `review`, `stats`, `storybook`,
`triage`.

`ci.yml`, `nix-eval.yml` and `pr-management.yml` have been moved to GitHub's own
runners. The rest is upstream automation that is dormant anyway — but each one
still queues for 24 hours whenever it triggers, which is why `storybook` is
sitting in the queue right now. Either change their `runs-on` or disable them.

> `.github/CI.md` says "Eighteen workflows"; the current count is sixteen.

### 4.3 Workflows that need `QUERYAI_API_KEY`

`review.yml`, `queryai.yml`, `duplicate-issues.yml` and the `check-duplicates`
job in `pr-management.yml` call a model. No such secret is configured, so they
cannot do useful work. `check-duplicates` skips itself for anyone in
[`.github/TEAM_MEMBERS`](.github/TEAM_MEMBERS).

---

## 5. Deliberately deferred

These are choices, not oversights — listed so they are not rediscovered as bugs.

- **`@queryai/desktop` is excluded from the `build` job.** Its prebuild
  downloads `@queryai/cli-<platform>` from npm and those packages do not exist
  under the new name yet, so it can only 404. Re-include it once 1.3 has
  published them.
- **`RELEASE_PAT` and `NPM_TOKEN` are optional.** Without `RELEASE_PAT` the
  release pull request opens but arrives with no checks (GitHub does not run
  workflows for events created by the built-in token). Without `NPM_TOKEN`
  releases still ship binaries; they just do not gain `npm i -g queryai`.
- **Windows code signing.** Needs a certificate. Until then Windows users get a
  SmartScreen warning, which the user README explains.
- **`publish.yml`.** The upstream workflow. Every job is gated on
  `github.repository == 'QueryAI-org/QueryAI'`. `release.yml` replaces the part
  that matters; the rest was left rather than half-migrated.
- **Homebrew, AUR, Docker, Scoop, desktop app releases.** No taps or images.
