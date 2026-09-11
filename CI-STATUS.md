# CI/CD integration status

Written 2026-09-08, against `1e24e849` (the head of `feat/public-distribution`)
and the `ci` run it triggered, [`34230567338`][run]. Everything here is read
back from GitHub rather than assumed.

The short answer to "why is the CI/CD not integrated in the actual GitHub
repo": **it is.** The workflows are pushed, PR #1 is open, and `ci` ran against
this exact commit. What is missing is enforcement, credentials, and the release
half — none of which is visible from the Actions tab, which is probably why it
looks absent.

[run]: https://github.com/ashutosh20git/QueryAI/actions/runs/34230567338

---

## Already working

`feat/public-distribution` is pushed and in sync with its remote. PR #1,
_Distribute binaries publicly without publishing the source_, is open against
`dev`. The `ci` workflow ran on head SHA `1e24e849`; `lint` and `format` pass,
as do `nix-eval` and both `pr-standards` jobs.

## 1. CI is red

`ci-ok` is doing its job and failing, because six jobs beneath it failed.

| check                    | result | detail                                                                       |
| ------------------------ | ------ | ---------------------------------------------------------------------------- |
| `lint`                   | pass   |                                                                              |
| `format`                 | pass   |                                                                              |
| `build`                  | fail   | `@queryai/app#build` — `bun run build` in `packages/app` exited 1             |
| `typecheck`              | fail   | runner received a shutdown signal mid-run; infrastructure, not code           |
| `unit (linux)`           | fail   | `WebFetchTool > returns an error result when HTML-to-Markdown conversion throws` |
| `unit (windows)`         | fail   |                                                                              |
| `e2e (linux)`            | fail   | `element(s) not found`, `locator.click` timeout at 60s, several `toEqual`/`toBeGreaterThan` |
| `e2e (windows)`          | fail   |                                                                              |
| `ci-ok`                  | fail   | correct — it aggregates the above                                            |

Two of these settle open questions in [`PENDING.md`](PENDING.md):

- **The Linux leg is not green.** PENDING.md § 2.1 records that the unit
  failures had only been reproduced on Windows and raises "the honest
  possibility is that some of these are Windows-only". Linux fails too, but on
  **one** test — `WebFetchTool` — not the fourteen seen on Windows. So most of
  that list is Windows-only; `WebFetchTool` is the one that is not.
- **`e2e` has now run**, contradicting PENDING.md § 2.2, and fails on both
  platforms. The decision that section anticipated — fix it, or drop it from
  `ci-ok`'s `needs:` rather than weakening the rule — is now live.

`build` failing is new and is not in PENDING.md at all.

## 2. Nothing enforces `ci-ok`

This is the real sense in which the pipeline is not integrated. The gate exists
and reports, but cannot block a merge:

```console
$ gh api repos/ashutosh20git/QueryAI/branches/dev/protection
403: Upgrade to GitHub Pro or make this repository public
$ gh api repos/ashutosh20git/QueryAI/rulesets
403: Upgrade to GitHub Pro or make this repository public
```

Branch protection and rulesets are unavailable on a **private repository on the
Free plan**. PR #1 can be merged red today. Resolving it means GitHub Pro, or
making the source repository public — which contradicts the point of the
two-repository split. Until then the gate is advisory.

## 3. The release workflows cannot be triggered yet

`release.yml`, `release-pr.yml` and `release-merge.yml` are all
`workflow_dispatch`, and GitHub only offers dispatch from the **default
branch**. These three files exist only on `feat/public-distribution`; `dev` has
never seen them.

So they do not appear in the Actions tab, and the rehearsal command in
PENDING.md § 1.3 fails today:

```bash
gh workflow run release --repo ashutosh20git/QueryAI -f version=0.1.0 -f draft=true
```

**PR #1 has to merge before any part of the release flow is reachable.** That
reorders PENDING.md § 1: 1.3 depends on § 2 and § 3 being resolved first, not
just on 1.1 and 1.2.

## 4. No secrets are configured

```console
$ gh secret list     # empty
$ gh variable list   # empty
```

What the release path reads:

| name          | required?               | purpose                                                                       |
| ------------- | ----------------------- | ----------------------------------------------------------------------------- |
| `DIST_TOKEN`  | **yes**                 | PAT with `contents:write` on `QueryAI-dist`. `GITHUB_TOKEN` cannot cross repos |
| `NPM_TOKEN`   | no — step self-skips    | publishes `npm i -g queryai`                                                  |
| `RELEASE_PAT` | no — falls back         | without it the release PR opens with no checks attached                       |
| `DIST_REPO`   | no — variable, defaults | defaults to `ashutosh20git/QueryAI-dist`                                      |

## 5. `QueryAI-dist` is still private

```console
$ gh repo view ashutosh20git/QueryAI-dist --json visibility
{"visibility":"PRIVATE"}
```

Release assets inherit their repository's visibility, so nothing published there
is downloadable by anyone but the owner. This defeats the entire arrangement and
exposes no source when fixed — see PENDING.md § 1.1.

## 6. Two runs are queued forever

| run          | workflow        | queued for |
| ------------ | --------------- | ---------- |
| `34230567126` | `storybook`     | 3h 28m     |
| `34158916545` | `pr-management` | 20h 22m    |

Both target `blacksmith-4vcpu-ubuntu-2404` — a paid runner class inherited from
upstream that this account has no subscription to. They will never start;
GitHub cancels them at 24 hours. Sixteen other workflows have the same problem
and are dormant, per PENDING.md § 4.2.

Separately, the `close-issues` and `close-prs` crons are failing on `dev` on
their own schedule. Also inherited upstream automation.

---

## What to do, in order

```bash
# 1. Make the distribution repository public
gh repo edit ashutosh20git/QueryAI-dist \
  --visibility public --accept-visibility-change-consequences

# 2. Create a PAT with contents:write on QueryAI-dist, then:
#    https://github.com/settings/tokens?type=beta
gh secret set DIST_TOKEN

# 3. Cancel the zombie runs
gh run cancel 34230567126 34158916545
```

4. Fix the red checks. `build` and the `WebFetchTool` unit test are the
   tractable ones and both reproduce on Linux; `e2e` needs a closer look, and
   `typecheck` may only need a rerun.
5. Merge PR #1, so the release workflows land on `dev` and become dispatchable.
6. Decide on GitHub Pro if `ci-ok` is to be a real gate rather than a report.
