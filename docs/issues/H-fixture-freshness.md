# H — Fixture-freshness as bot-status (not wall-clock CI fail)

**Parent epic:** EPIC-103
**Effort:** ~2 hours
**Blocked on:** issue A (fixtures must exist before freshness is meaningful)
**Why this exists:** v2 spec § 11 proposed warning at 30 days before `stale_after`, then hard-failing CI at `stale_after` + 30-day grace. gemini's must-fix verdict: "Ticking time bomb. Hard-failing CI based on wall-clock time guarantees catastrophic, simultaneous pipeline failures the second the grace period expires. This will block an emergency hotfix because a completely unrelated fixture aged out that morning." Replacement: bot-status alert on every PR; never break the build on wall-clock.

## Acceptance criteria

1. `scripts/ci/check-fixture-freshness.mjs` exists. Reads every `tests/smoke/fixtures/<plugin>/<scenario>.provenance.json`. For each:
   - If `stale_after` is in the past: emit a `STALE` record.
   - If `stale_after` is within 30 days: emit a `WARNING` record.
   - Else: emit no record.

2. **Bot-status check** at `.github/workflows/fixture-freshness.yml`:
   - Triggered on `pull_request:` AND on `schedule:` (e.g., weekly).
   - On PR: posts a non-blocking comment summarizing fresh/warning/stale fixture counts. Does NOT fail merge.
   - On schedule: opens an issue if any fixture is `STALE` for >2 weeks AND no rerecording PR is open.

3. **Re-record PR auto-open:** when a fixture goes stale, the scheduled job opens a PR for re-recording (calls `scripts/smoke-rerecord.mjs` from issue A). Re-recording itself is gated on workflow_dispatch + secrets — the auto-PR is just a placeholder reminding operators.

4. **`stale_after` policy** documented in `docs/contracts/api-reviewers-output.md` § Persistence (extend the provenance schema doc):
   - Default = 90 days from `recorded_at`.
   - Operators can set lower for fast-changing providers.
   - Cannot be set higher than 180 days (provider drift past 6 months is unsafe to assume).

## Code references

- v2 spec § 11 fixture provenance schema (kept).
- gemini's must-fix on Q8.
- Issue A (fixture recording MVP) — fixtures must exist before this issue's gate is meaningful.

## Out of scope

- Diff-alert pipeline that compares re-recorded fixtures against current and flags shape changes. That's a separate concern (call it I' or part of A's follow-up).
- Auto-merging re-record PRs without review.

## Why this is materially different from v2's wall-clock fail

- An emergency hotfix at 03:00 UTC the morning a fixture expires is no longer blocked.
- Stale fixtures still surface — visibly, durably, in PR comments and a tracking issue.
- The recording gate (workflow_dispatch + secrets) is still preserved; only the soft-fail is changed.
