# D — Per-PR flake gate with pass-rate threshold + bucketing

**Parent epic:** EPIC-103
**Effort:** ~3 hours
**Blocked on:** nothing
**Why this exists:** v2 spec proposed per-PR 5× rerun on changed smoke targets + nightly 20× on full suite. gpt-5.5-pro's missed-concern: "5×/20× reruns can normalize flakiness. Where is the stop-ship policy, quarantine policy, and failure bucketing? Reruns without action thresholds become a flake laundering system." This issue adds the missing thresholds + bucketing.

## Acceptance criteria

1. `scripts/ci/run-tests-repeat.mjs` exists. Args: `--target=<smoke target> --times=<N> --pass-rate-threshold=<percent>`. Runs the target N times serially. Captures per-run pass/fail per individual test.

2. **Pass-rate threshold:** the gate fails the job if any individual test's pass rate across N runs is below the threshold. Default threshold = 100% (all runs pass). Lower is operator-configurable per workflow.

3. **Failure bucketing:** on any flake (one or more runs failed), the gate emits a structured report:
   ```
   FLAKE: <test-name>
     pass_rate: 4/5 (80%)
     failure_runs: [3]
     failure_message_run_3: <captured stderr/stack snippet>
     bucket: <auto-classification: timeout | network | race | uncategorized>
   ```
   The `bucket` is determined by a small classifier on the failure message — known patterns ("ECONNREFUSED" → network, "exceeded the configured timeoutMs" → timeout, etc.).

4. **Quarantine file** at `tests/known-flaky.yml`. Lists test names + the bucket they're known-flaky-in + a tracking issue. Tests in this file are reported as "expected flake" rather than "new flake" but still counted toward the pass-rate threshold (so quarantined-but-degrading tests still surface).

5. `.github/workflows/flake-pr.yml` exists:
   - `on: pull_request:` with `paths: ['tests/smoke/**', 'plugins/*/scripts/**']`.
   - Identifies smoke target(s) most affected by changed files (parse the diff; for each plugin/* file changed, include its smoke target).
   - Calls `node scripts/ci/run-tests-repeat.mjs --target=<t> --times=5 --pass-rate-threshold=100`.

6. `.github/workflows/flake-nightly.yml` exists:
   - `on: schedule: cron: '0 7 * * *'` (07:00 UTC).
   - Matrix over the 5 smoke targets.
   - Calls `node scripts/ci/run-tests-repeat.mjs --target=<t> --times=20 --pass-rate-threshold=100`.

7. **Anti-laundering check:** if a test's pass rate has dropped from the previous nightly run by more than 10% (e.g., 100% → 80%), the gate emits an extra `DEGRADING` flag in the report.

## Code references

- gpt-5.5-pro's flake-laundering critique.
- v2 spec § 10 (per-PR + nightly cadence — kept).
- Issues #25 (50× run on Linux) and #30 (5× pre-commit pass) — see Layer 2 — both asked for determinism gates that v1 didn't add.

## Out of scope

- Auto-quarantine on first flake. Quarantine remains operator-decided.
- Cross-PR flake correlation (test that flakes only on PRs touching plugin X). Tracked separately if needed.

## Why bucketing matters

Without buckets, every flake is "the suite is flaky." With buckets, operators see "we have 3 timeout-class flakes and 1 race-class" — actionable. gpt-5.5-pro flagged this as the difference between robustness work and flake laundering.
