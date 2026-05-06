# G — Honesty banner as bot-status check (not CI fail)

**Parent epic:** EPIC-103
**Effort:** ~2 hours
**Blocked on:** nothing
**Why this exists:** v2 spec § 12 proposed enforcing the smoke-output honesty banner as a CI gate — every "DOES NOT PROVE" line must reference an open follow-up issue. gemini's must-fix verdict: "Actively harmful... taxing honesty. Devs will create garbage zero-context issues to appease CI, OR stop writing 'DOES NOT PROVE' lines." Replacement: bot-status check on the PR, not a CI fail.

## Acceptance criteria

1. **The honesty banner template exists and is emitted by every smoke job.** The banner content is the v2 spec § 12 template (a `SMOKE PROVES` / `SMOKE DOES NOT PROVE` block).

2. **Bot-status PR check** at `.github/workflows/honesty-banner-check.yml`:
   - Triggered on `pull_request:`.
   - Parses the smoke job's banner output from each smoke target's log.
   - For each "DOES NOT PROVE" line, checks whether the line references an open issue (`#NNN` parsing).
   - Posts a non-blocking PR comment summarizing: "Honesty banner mentions N gap(s); M referenced via tracking issue, K do not."
   - Does NOT fail the merge.

3. **`[WONTFIX]` and `[ACCEPTED-RISK]` bypass tokens.** A "DOES NOT PROVE" line that includes `[WONTFIX]` or `[ACCEPTED-RISK]` does not require an issue reference. The bot lists these separately so they're visible.

4. **Operator workflow:** when a real new gap is identified, the operator either:
   - Files an issue and adds the reference to the line.
   - Marks `[ACCEPTED-RISK]` if the gap is intentionally not tracked.
   - Marks `[WONTFIX]` if the gap will never be addressed (rare).

5. **Closing-issue cleanup:** scheduled weekly job `.github/workflows/honesty-banner-cleanup.yml` checks every issue referenced by a banner line. If any issue is closed, opens a PR removing the line (or surfacing for operator decision).

## Code references

- v2 spec § 12 honesty banner template (kept).
- gemini's must-fix on Q6.
- v2 spec § 12 enforcement (rejected; demoted to bot-status here).

## Out of scope

- Auto-creating tracking issues for bare lines. Operator-driven.
- Banner content changes. The banner template stays as v2 spec § 12 specifies.

## Why this is materially different from v2's enforcement

- A bot comment is informational; a CI fail is coercive.
- `[ACCEPTED-RISK]` lets honest-but-untracked gaps survive without garbage issues.
- The weekly cleanup catches drift (closed issues that shouldn't still be in the banner) without paging on every PR.
- The banner remains useful (shows what was/wasn't proven) without becoming a friction tax.
