# C — Regression-coverage linker via PR-diff extraction

**Parent epic:** EPIC-103
**Effort:** ~3 hours
**Blocked on:** nothing
**Why this exists:** The v2 spec proposed `regression_signatures` curated by issue-closers in issue frontmatter. gemini's verdict was strong-objection: "Devs close bugs via `Fixes #123`. They will not retroactively edit issue frontmatter. The gate will silently pass because the input set is always empty." The replacement extracts signatures from PR diffs at merge time, then verifies tests reference them.

## Acceptance criteria

1. `scripts/ci/extract-regression-signatures.mjs` exists. Run on PR merge (via merged-PR webhook OR scheduled hourly job). For each merged PR that closes a bug-labeled issue:
   - Parses the merged diff for added/modified test files.
   - Extracts the literal strings inside `t.test("...")` and the bare strings in any `assert.match(/.../)` regex literals.
   - Filters to substrings that appear in the issue body (the "failure signature" — error_code values, error_message prefixes, named symbols).
   - Writes the (issue#, [signatures]) pairs into `tests/regression-coverage-cache.yml`.
   - The cache is committed by a bot or by the next merge — the cache-update strategy is documented at top of the file.

2. `scripts/ci/check-regression-coverage.mjs` exists. Reads the cache. For each closed bug-labeled issue:
   - If the cache has signatures: `grep -rl <signature> tests/` must return at least one match per signature.
   - If the cache has empty signatures: that issue is exempted (no testable surface) and a reason field is required in the cache entry.
   - If the cache has no entry at all for the issue: the gate emits a one-time prompt to the closing operator AND adds a `pending_extraction` record so the gate doesn't re-prompt.

3. `tests/regression-coverage-exemptions.yml` exists for opt-outs (e.g., docs-only bugs, infrastructure issues that don't have a testable failure signature). Each exemption has issue # + specific reason.

4. Wired into `package.json` as `lint:regression-coverage` and into CI `lint`.

5. **Bootstrap:** populate the cache for the 11 high-signal closed bugs from Layer 2's archaeology as part of this issue. Use the `evidence_strength: semantic` rows; the failure-signature strings (`argv0_mismatch`, `Max number of steps reached`, `scope_total_too_large`, etc.) are the cache values.

6. The cache-update strategy: documented at top of `tests/regression-coverage-cache.yml`. Either:
   - **Cron-driven:** scheduled job (every N hours) scans recently-merged PRs, updates cache, opens auto-PR with diff. Reviewers approve the auto-PR; merge updates production cache. Drawback (per gemini): PRs that close issues fail CI between cron-update and human-merge.
   - **Build-derived:** matrix gate derives the cache from `gh pr list --merged --search "closes:#NNN"` at lint time. Drawback: network dependency in lint.
   - **Hybrid:** primary = cron-driven cache file; fallback = derived from `gh` if cache is older than `cache_max_age_hours`.

   Pick one in implementation. Document the choice + tradeoff in the doc-string.

## Code references

- v2 spec § 7 (rejected): `regression_signatures` in issue frontmatter.
- gemini's recommendation: "Automate signature extraction from the PR diff."
- Layer 2 archaeology: `docs/closed-issue-failure-modes.md` § Table 1 has the bootstrap signatures already enumerated.

## Out of scope

- A general-purpose code-coverage tool. We're matching named signatures, not measuring branch coverage.
- Multi-PR fix tracking. If issue #N is fixed across PRs A and B, both PRs' diffs are scanned; the union is the signature set.

## Why this is more workable than v2's design

- Operator does no extra work at issue-close time. The signal comes from the test code they would have written anyway.
- The cache is auditable in git history. Drift is visible.
- False positives are recoverable via the exemptions file.
- Bootstrap from Layer 2 means the gate has signal from day one, not from "after operators learn the new rule."
