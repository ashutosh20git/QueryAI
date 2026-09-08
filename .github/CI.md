# CI and the merge gate

## The gate

Everything that decides whether a pull request is mergeable lives in
[`workflows/ci.yml`](workflows/ci.yml). It runs `lint`, `format`, `typecheck`,
`build`, `unit` (Linux + Windows) and `e2e` (Linux + Windows) in parallel, and
then one final job:

| job     | meaning                                       |
| ------- | --------------------------------------------- |
| `ci-ok` | succeeds only if every job above it succeeded |

`ci-ok` is the only check worth marking as required. It runs with `always()`, so
when something upstream fails it reports a failure rather than being skipped —
a skipped check leaves branch protection waiting forever. Because the required
check is an aggregate, adding, renaming or removing a job in `ci.yml` never
means editing the protection rule.

## Turning "all checks passed" into "cannot merge"

Passing checks are only advisory until a branch protection rule requires them.
**Branch protection and rulesets are not available for a private repository on a
free GitHub plan** — the API returns `403 Upgrade to GitHub Pro or make this
repository public`. Make the repository public, or upgrade the account, before
the steps below will work.

Then, once per repository:

1. **Settings → Branches → Add branch ruleset** (or classic _Add rule_).
2. Target branch: `dev`.
3. Enable **Require a pull request before merging**. Leave _Required approvals_
   at 0 if you are reviewing and merging your own work — the rule still forces
   changes through a PR, which is what makes the checks run.
4. Enable **Require status checks to pass before merging**, and add **`ci-ok`**
   as the only required check.
5. Enable **Require branches to be up to date before merging** so `ci-ok` is
   judged against the merged result rather than a stale branch.
6. Optionally enable **Do not allow bypassing the above settings**. Without it,
   an admin (you) can still merge a red PR — convenient, but it means the gate
   is advisory again.

After that a pull request shows **"All checks have passed"** with a green merge
button, or **"Required statuses must pass before merging"** with the merge
button disabled, which is the accepted / needs-revision distinction.

Adding `e2e` to the required set is deliberate but worth revisiting: it is the
slowest and least stable job. If it proves flaky, drop it from the `needs:` list
of `ci-ok` rather than weakening the rule, so the gate keeps meaning something.

## What is deliberately not gated

- **`@queryai/desktop` build.** Its prebuild downloads the published
  `@queryai/cli-<platform>` packages from npm and they do not exist yet under
  the new name, so the build can only 404. Re-add it to the `build` job once
  those packages are published.
- **Workflows that need `QUERYAI_API_KEY`.** `review.yml`, `queryai.yml`,
  `duplicate-issues.yml` and the `check-duplicates` job in `pr-management.yml`
  call a model. No such secret is configured, so they cannot do useful work.
  `check-duplicates` skips itself for anyone listed in
  [`TEAM_MEMBERS`](TEAM_MEMBERS).
- **Blacksmith runners.** Eighteen workflows still request
  `blacksmith-4vcpu-ubuntu-2404`, a paid third-party runner this account has no
  subscription to. Jobs asking for one queue until GitHub cancels them at 24
  hours. `ci.yml`, `nix-eval.yml` and `pr-management.yml` have been moved to
  GitHub's own runners; the rest are upstream automation that is dormant anyway.
  If you ever re-enable one of those workflows, change its `runs-on` first.

## Releasing

Shipping is a separate pipeline that hangs off the same gate: `release-pr.yml`
opens a version-bump pull request, `ci.yml` judges it, and merging it triggers
`release-merge.yml` -> `release.yml`, which publishes to the public distribution
repository. See [`../RELEASING.md`](../RELEASING.md).

## Running the same checks locally

```sh
bun run lint              # oxlint
bunx prettier --check .   # formatting
bun typecheck             # tsgo across the workspace
bun turbo build --filter='!@queryai/desktop'
bun turbo test            # unit tests; do not run `bun test` from the root
```

`.husky/pre-push` already runs `bun typecheck` before a push.
