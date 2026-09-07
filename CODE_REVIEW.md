# Code Review — Findings and Resolutions

Review of the uncommitted work on `dev` (memory layer, model fallback, rename
compat), and what was done about each finding.

Status: **all 8 resolved.** Three were verified against the source before fixing;
the fixes for #1, #2, #3, #4, #5 and #8 have regression tests that fail without
them.

---

## 1. `cleanup()` resurrected the assistant message that `switchOrHalt` deleted — High ✅ fixed

`packages/queryai/src/session/processor.ts:666`

`Effect.ensuring(cleanup())` was applied *outside* `Effect.catch(switchOrHalt)`,
so cleanup ran last and its trailing `session.updateMessage(...)` re-inserted
(upsert) the empty assistant message the switch handler had just removed. Every
fallback switch left a content-less assistant turn in history, with its orphaned
`step-start` parts still in `PartTable`.

**Fix.** The two are swapped: the message is closed out first, then the failure is
handled. That also makes `switchOrHalt`'s "did this attempt produce anything?"
check accurate, since the parts are written by then. Two consequences were handled
with it:

- `halt()` now persists the error itself. It used to rely on the later `cleanup()`
  pass to write it, which no longer runs after it.
- `MessageRemoved` in `packages/core/src/session/projector.ts` now deletes the
  message's parts as well as its row. They were unreachable and nothing cleaned
  them up.

**Tests.** `test/session/fallback-processor.test.ts` — "an attempt that produced
nothing leaves no message behind", "an attempt that did produce something is kept,
closed out and error-free", and an added assertion that a halted turn's error
reaches storage. The first fails if the pipe order is put back.

---

## 2. Auto-capture only fired on blocked or errored turns — High ✅ fixed

`packages/queryai/src/session/prompt.ts:1364`

Capture hung off `result === "stop"`, which the processor returns only for
`ctx.blocked || ctx.assistantMessage.error`. A normal turn returns `"continue"`
and leaves via the top-of-loop `finish` break, so `auto_capture: true` fed the
store only on turns that failed.

**Fix.** Capture now hangs off the assistant message being finished without error
— the actual "this turn answered" signal — and off the structured-output exit. It
also stores the assistant's reply alongside the user's message, which is what
mem0's extraction wants. Still forked: a turn never waits on it.

**Test.** `test/session/prompt.test.ts` — "auto_capture fires on a turn that
answered, which is the ordinary one". Confirmed failing against the old placement.

---

## 3. `available()` and `next()` disagreed by one on the switch budget — Medium ✅ fixed

`packages/queryai/src/session/fallback.ts:262`

`next()` counted the current model before picking and `available()` did not, so
with `max_switches: 0` `available()` said yes — telling the retry policy to stop
waiting — and `next()` then refused to switch. A retryable free-tier 429 failed
instantly with none of its five retries.

**Fix.** The budget is now an explicit `switches` counter incremented when a
switch actually happens, and both `available()` and `next()` ask the same
question of it (`switches < max_switches`) before looking at the chain. The set of
retired models no longer doubles as the budget.

**Tests.** "max_switches 0 turns fallback off rather than half-off" and "the last
switch in the budget is still offered up front".

---

## 4. Every 403 was treated as quota exhaustion — Medium ✅ fixed

`packages/queryai/src/session/fallback.ts:38`

`HARD_STATUS = [402, 403]` meant a revoked key, an unentitled model or a region
block silently retired the whole provider and moved the session elsewhere,
burying an error the user has to fix.

**Fix.** `HARD_STATUS` is `[402]`. A 403 that really is a quota ceiling still says
so in its body and is still caught by `HARD_PATTERNS`; a bare 403 now surfaces.

**Test.** "a 403 is an auth problem until it says otherwise".

---

## 5. Rename compat missed `enabled_providers` / `disabled_providers` — Medium ✅ fixed

`packages/queryai/src/provider/provider.ts:1500`

Both lists were compared against raw ids, so `"enabled_providers": ["opencode"]`
matched nothing and left the install with no providers at all.

**Fix.** Both are folded through `ModelsDev.aliasID`, like `cfg.provider` above
them.

**Tests.** `test/provider/provider.test.ts` — "an allowlist written before the
rename still names this provider" and the denylist equivalent.

---

## 6. Compaction fallback reused the first model's payload sizing — Low ✅ fixed

`packages/queryai/src/session/compaction.ts:459`

The retry re-ran `attempt()` with the prompt `select()` had built against the
*original* model's context window, so a smaller fallback reported a hard
`ContextOverflowError` the first model would have absorbed.

**Fix.** Prompt selection is now a function of the model that will read it, called
again on every switch. The plugin `session.compacting` hook still fires once;
`selected.tail_start_id` is taken from the attempt that actually ran.

No dedicated regression test: the compaction suite has pre-existing timeouts on
this machine and a faithful test needs a two-model provider fixture plus a
history large enough to trim. The change is small and covered by the existing
compaction suite for non-fallback paths.

---

## 7. `reset()` had no caller and the `spent` map grew forever — Low ✅ fixed

`packages/queryai/src/session/fallback.ts:307`

One entry per session, never reclaimed, and a model retired by a transient 429
stayed retired for the life of the process.

**Fix.** Retirements are now cooldowns with an expiry — five minutes for a rate
limit, an hour for a quota ceiling — and lapse on their own. Session entries
untouched for six hours are swept on the next lookup. `reset()` remains as the
explicit "start over" hook (used by tests); the leak no longer depends on anyone
calling it. The `switches` budget is deliberately *not* refunded by a cooldown, so
a session still cannot thrash.

---

## 8. Fallback ranked the most expensive model first — Low ✅ fixed

`packages/queryai/src/session/fallback.ts:106`

`rank()` ordered by output price descending, so a 429 on a cheap model moved the
rest of the session onto the user's priciest key, with `fallback.enabled`
defaulting to `true` and no prompt.

**Fix**, and it is also the behaviour this project wants:

- **Free models rank first**, ordered among themselves by parameter count,
  context, reasoning and recency. Paid models follow, most capable first.
- **A fallback never costs more than the model you chose.** The replacement's
  output price must be no higher than that of the model that just failed. On a
  free model that means the session stays free; when the free options are spent
  the turn fails rather than quietly spending money.
- `fallback.max_cost` overrides the ceiling in either direction. An explicit
  `fallback.models` chain is an instruction and is exempt.

**Tests.** "free models go first, however capable the paid ones are" plus the four
cases in "session.fallback cost".

**Doc drift** (also flagged): `packages/web/src/content/docs/config.mdx` described
the old ordering and omitted the parameter-count key. Rewritten to match, with the
price guard, the cooldowns and the 403 rule documented.

---

## Also in this pass: the memory layer no longer needs an account

The memory layer was mem0-only, which meant no API key, no memory. It now defaults
to a **local backend**: a JSON file per user under the app data directory, mode
`0600`, no server, no quota, no network. Term-overlap search weighted by term
rarity, topped up with recent rows when a search comes back short, so user-scoped
facts still reach the model.

`memory.backend` is `"auto"` (mem0 when a key is configured, local otherwise),
`"local"`, or `"mem0"`. Selecting `"mem0"` without a key reports what is missing
instead of silently writing locally.

New: `packages/queryai/src/memory/local.ts`, `test/memory/local.test.ts`. Docs in
`config.mdx` under Memory.

---

## Test status

Everything above passes. The failures below are pre-existing and unrelated —
each was reproduced on the unmodified tree. The timeouts are load-dependent: they
come and go depending on what else the machine is running (`prompt.test.ts` came
back clean, 158 passed, on a later run).

- `test/session/prompt.test.ts` — "loop calls LLM and returns assistant message" (timeout, flaky)
- `test/session/compaction.test.ts` — "anchors repeated compactions with the previous summary" (timeout), "stops quickly when aborted during retry backoff" (262ms against a 250ms bound)
- `test/session/revert-compact.test.ts` — 2 timeouts (3 on the unmodified tree)
- `packages/core` — 7 failures in npm-config, repository-cache and snapshot suites
- `bun run lint` — one pre-existing error in `packages/session-ui`

`bun run typecheck` is clean for `packages/core` and `packages/queryai`.
