# B — Coverage matrix v2 (per-plugin + bijective validator + cross-arch hash salting)

**Parent epic:** EPIC-103
**Effort:** ~4 hours
**Blocked on:** nothing
**Why this exists:** v2 spec proposed a per-plugin matrix shape but missed three implementation concerns the panel raised: bijective code↔matrix validation (qwen — without it the matrix becomes static fiction), cross-arch hash collisions (qwen — `flow=review` may hash identically across companion and grok without salting), local-cache desync trap for tracked-issue references (gemini).

## Acceptance criteria

1. `tests/coverage-matrix.yml` exists with the per-plugin shape from `docs/IMPLEMENTATION-PLAN.md`'s "What is decided" table. Cells are one of: `test: <file>::<test-name>`, `uncoverable: <reason> #NNN`, `unfilled_tracked: <issue-number>`. Bare absence = UNFILLED.

2. `scripts/ci/check-coverage-matrix.mjs` exists with these gates:
   - Schema-validate the YAML.
   - Enumerate the per-plugin Cartesian product (`flows × modes × cases`).
   - For each tuple: require exactly one of `test | uncoverable | unfilled_tracked`. Bare UNFILLED fails.
   - **Bijective validator:** load the actual plugin command registries from `plugins/<plugin>/scripts/<plugin>-companion.mjs` (or `<plugin>-web-reviewer.mjs` / `api-reviewer.mjs`). Diff against the matrix's per-plugin command list. Fail if any matrix command is absent in code OR any code command is absent in the matrix.
   - **Cross-arch hash salt:** when computing tuple hashes (for any caching downstream), use `<arch>:<plugin>:<flow>:<mode>:<case>` as the key. Test that `flow=review,mode=foreground,case=happy_path` produces a different hash for `arch=companion,plugin=claude` vs `arch=grok,plugin=grok`.
   - For each `test:` cell: require the file exists and the test-name is grep-matchable in that file.
   - For each `uncoverable:` cell: require the reason references an issue `#NNN`.
   - For each `unfilled_tracked:` cell: validate against a local file `tests/regression-coverage-cache.yml` (NOT live `gh` — see issue C for cache-update strategy).

3. **No bare UNFILLED tuples ship.** First-pass population uses `unfilled_tracked` for any genuinely-uncovered tuple; population happens by an operator using Layer 2's archaeology table as the source.

4. Wired into `package.json` as `lint:coverage-matrix` and into the CI `lint` job.

5. Print a summary: `coverage: X/Y per-plugin tuples covered, W uncoverable, V tracked-unfilled, U bare-UNFILLED; A architecture invariants verified.`

6. **Architecture-invariants block** is a SEPARATE file — `tests/coverage-architecture-invariants.yml`. Keys are universal (e.g., `source_content_transmission_mapping`) and values reference real tests. The matrix gate ALSO validates this file but with overlay semantics: a per-plugin cell that conflicts with an architecture invariant fails.

## Code references

- Per-plugin matrix shape source: `docs/IMPLEMENTATION-PLAN.md` § decided table + Layer 1 enums.
- Plugin command registries to introspect: `docs/path-maps/companion.md` § dispatch tables (cite file:line for each plugin's command list); `docs/path-maps/grok.md` § Top-level dispatch; `docs/path-maps/api-reviewers.md` § Top-level dispatch.
- Cross-arch hash collision concern: panel finding (qwen). Path-map-cited examples: `flow: review` exists in companion (run --mode review) AND grok (run --mode review with different code paths) AND api-reviewers (run --mode review).
- Local-cache desync concern: panel finding (gemini). Strategy: **derive the cache from PR-diff signal at build time, not from a manually-maintained file**. See issue C for the mechanism — issue B uses whatever C produces.

## Out of scope

- The `regression_signatures` extraction that populates the cache. That's issue C.
- Real bijective validation of `_run-worker` (background helper) flows — those are internal entrypoints, not user-invocable. Tracked as `internal_only: true` in the matrix; bijective validator skips them.

## Concrete first-day result

After this issue lands and the matrix is populated using Layer 2's archaeology, the CI summary prints something like:

```
coverage: 187/256 per-plugin tuples covered, 12 uncoverable, 57 tracked-unfilled, 0 bare-UNFILLED; 2 architecture invariants verified.
```

That's the auditable signal #103 asks for in its acceptance criterion 1.
