# M1 adversarial-review findings + disposition

Reviewer: `general-purpose` subagent, invoked with adversarial-review role prompt.
Ran against `feat/m1-libs` branch (pre-commit).

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | HIGH | Module-level mutable CONFIG creates race/pollution risk if two test files share a process | **PARTIAL** — converting to factory per spec §6.2 would force rewriting every upstream import site (violates "preserve upstream API" port principle). Kept module-level `configureState()`/`configureTrackedJobs()` pattern but: (a) enforced single-source-of-truth — tracked-jobs now reads `sessionIdEnv` from state.mjs CONFIG rather than maintaining its own copy; (b) documented the trade-off in UPSTREAM.md. M2+ companion callers call `configure*` once at startup and don't touch CONFIG again. Test isolation remains on fresh tmpdirs. |
| 2 | HIGH | UPSTREAM.md contradicts code (claimed factory API; code uses module-level) | **FIXED** — UPSTREAM.md now accurately describes `configure*()` setters and calls out the deviation from spec §6.2's factory syntax. |
| 3 | MEDIUM | fs.mjs default prefix makes files non-identical between plugin copies | **ACCEPTED AS DIVERGENCE** — UPSTREAM.md now lists `fs.mjs` honestly as target-specific. The alternative (required prefix, no default) would break upstream signature compat. Callers should pass explicit prefixes; default is a fallback. |
| 4 | MEDIUM | tracked-jobs and state had independent sessionIdEnv copies | **FIXED** — `createJobRecord` reads from `getStateConfig().sessionIdEnv`; `configureTrackedJobs({sessionIdEnv})` now forwards into `configureState`. Single source of truth restored. Applied to both plugin copies. |
| 5 | MEDIUM | Test coverage gaps (saveState cleanup, runTrackedJob paths, slug sanitization, plugin-copy sync) | **PARTIAL** — Added `plugin-copies-in-sync.test.mjs` which (a) asserts the 6 verbatim files are byte-identical across claude/gemini; (b) asserts render.mjs has no surviving Codex refs in either copy. `saveState` / `runTrackedJob` / slug sanitization tests deferred to M2 where they'll be exercised by the real dispatcher — adding them now would only test library-internal behavior without a real consumer. |
| 6 | MEDIUM | run-tests.mjs walks recursively without excluding node_modules/fixtures | **FIXED** — `SKIP_DIRS` excludes `node_modules`, `fixtures`, `.git`, `coverage`. |
| 7 | LOW | MIT attribution sufficiency of NOTICE + UPSTREAM.md | **ACCEPTED** — standard Apache-foundation pattern; reviewer acknowledged defensibility. |
| 8 | LOW | `prompts.mjs` may hardcode a target-specific path | **DEFERRED to M2** — only 13 lines, no hardcoded path observed on read, but actual consumers don't exist yet. Verify during M2 dispatcher wiring. |
| 9 | LOW | `render.mjs` post-substitution clean (reviewer's own verification) | — |
| 10 | LOW | Uncommitted work at session end | **FIXED** — M1 committed this revision. |

## Carried over to M2+ hazards

1. **Module-level CONFIG test isolation** — if M2+ adds a test suite that imports both plugin libs in the same process, test order could matter. Mitigation: document in `tests/README.md` that tests must not cross plugin boundaries in a single file.
2. **saveState cleanup / runTrackedJob paths untested** — M2's dispatcher exercises these; add integration-ish tests there.
3. **prompts.mjs re-verification** — check for hardcoded paths when wired.

## Upstream design limitations accepted for v1

These findings surfaced in gate-1 audits against the gemini copy but apply to
both plugins (we ported the same upstream logic). They reflect upstream
`openai/codex-plugin-cc` behavior that we match intentionally; see spec §12
for the workspace-scoped single-writer assumption.

| Finding | Severity | Disposition |
|---|---|---|
| `saveState` race: concurrent saveState calls from two processes can clobber each other's writes (no flock) | CRITICAL | Upstream intentionally uses atomic `writeFileSync` assuming single-writer per workspace. Two plugin invocations targeting the same workspace at the same instant is not a documented or supported pattern (spec §12). v1 ships with upstream behavior. File-locking is a v2 candidate. |
| `readJobFile` accepts arbitrary path (no validation that it's inside jobs dir) | HIGH | Function is internal-ish; all current callers pass `resolveJobFile(cwd, id)` which we now validate at the jobId level. Narrowing `readJobFile`'s export surface is a v2 API break; v1 keeps the upstream signature. |
| `updateState` invokes `mutate` synchronously; async mutate would save before mutation completes | MEDIUM | Upstream contract documents mutate as synchronous. Call sites in the companion (M2+) only pass sync functions. Linting the call signature on dispatcher files is a v2 candidate. |

All three are documented here and re-raised in `.autonomous/findings-m1.md`
whenever an upstream re-sync changes the affected code (see
`plugins/<target>/scripts/lib/UPSTREAM.md` re-sync procedure).
