# Path maps — index and operational rules

These are end-to-end traces of every command function in the three reviewer-plugin architectures. Each doc is grounded by reading the canonical entrypoint files in full at the time of audit, with file:line citations.

## Index

| Doc | Architecture | Plugins covered | Lines | Approx. flows |
|---|---|---|---|---|
| [`companion.md`](./companion.md) | companion | claude, gemini, kimi | 441 | 8 (preflight, run, _run-worker, continue, ping[=doctor], status, result, cancel) × foreground/background |
| [`grok.md`](./grok.md) | grok | grok-web-reviewer + grok-sync-browser-session | 508 | 5 reviewer flows (doctor, run, result, list, help) + browser-session-sync (separate entrypoint) |
| [`api-reviewers.md`](./api-reviewers.md) | api-reviewers | deepseek + glm (config-only divergence) | 455 | 3 (doctor, run, help) — NO status/result/cancel/list |

## How to use this directory

This is a *snapshot* of code paths at the time of Layer 3. Use it as **navigation**, not source of truth — the code is the source of truth. The path maps reduce time-to-orient when you're touching a flow you haven't worked on.

### When to read which doc

- **You're adding a new failure mode** to an existing flow → read the path-map for that architecture's flow. Look for the step where the new failure originates. Confirm the failure produces the right `error_code` per `docs/contracts/job-record.md` (companion) or per the architecture's output doc.
- **You're adding a new flow** (new `cmd<Foo>` function) → read the entire path-map for that architecture. Note where existing flows handle each cross-cutting concern (auth, scope, persistence, redaction, lifecycle event). New flows must handle the same concerns or document why they don't.
- **You're touching a shared lib** (`scripts/lib/*.mjs` synced across plugins) → read the "Provider-specific divergences" section of `companion.md` to see which plugins use which fields. Synced changes must hold for all three companion plugins.
- **You're debugging a production failure** → read the architecture's path-map to identify which step the failure originates in. Then read the test references at that step (cited from `docs/closed-issue-failure-modes.md`).

### What the path maps DO

- Trace each `cmd<Flow>` function from entry to terminal output.
- Cite file:line for entry, prelaunch checks, provider call, persistence, output emission.
- Document state mutations at each step (sidecars, lock files, state.json upserts, worktree creation/disposal).
- List failure modes that can fire at each step, with `error_code` enum values.
- Cross-reference `docs/closed-issue-failure-modes.md` for known regressions per failure mode.

### What the path maps do NOT do

- They do not replace reading the actual code. File:line citations point you at the code; you still need to look.
- They are not updated automatically. **A path-map will go stale when the code changes.** Treat any cited `file:line` older than 30 days with suspicion; verify against current code before relying on a specific line number.
- They do not document tests. Test references come from `docs/closed-issue-failure-modes.md` (Layer 2). The split keeps each doc focused.

### Architectural asymmetries the maps make explicit

These are surfaced in each doc's "What this architecture does NOT have" section. New work must respect them:

- **Companion has 8 commands; grok has 5; api-reviewers has 3.** New flows do not exist symmetrically. Don't propose a `cmdCancel` for grok — there's no background worker to cancel.
- **Companion plugins share a JobRecord schema (41 keys, version 10); grok and api-reviewers each have their own schemas.** Cross-plugin generic test code that asserts on JobRecord fields will fail for grok and api-reviewers.
- **Redaction is three different mechanisms.** Companion = pre-spawn env-strip. grok = output-time JSON-tree. api-reviewers = output-time regex with `[REDACTED]`. Don't write a single "redaction property" that asserts the same invariant for all three.
- **Status enum varies.** Companion = 6 values (queued/running/completed/cancelled/failed/stale). grok and api-reviewers = 2 values (completed/failed). Don't assume `status === "running"` is a valid intermediate state for grok or api-reviewers.

### Updating these maps

When code structure changes meaningfully (a new `cmd<Foo>` lands, a flow's persistence layer changes shape, a new failure mode is added), the path-map for that architecture should be updated in the same PR. The discipline here is the same as `docs/contracts/`: code change + map change in one PR, or the map gets stale.

## Cross-cutting concerns

Concerns that span all path maps:

- **Source-transmission classification** — see `docs/contracts/external-review.md`. The deterministic mapping is universal; each path-map shows where it fires.
- **External-review event emission** — see `docs/contracts/lifecycle-events.md`. The 2 named events (`external_review_launched`, `launched`) emit at specific points in each path map.
- **Redaction surface** — see `docs/contracts/redaction.md`. Each path-map documents WHERE the redaction is applied for that architecture.
