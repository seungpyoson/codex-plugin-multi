# I — Property-test pay-for-itself probe (optional, low priority)

**Parent epic:** EPIC-103
**Effort:** ~3 hours
**Blocked on:** nothing
**Why this exists:** v2 spec § 8 proposed a primary property test on `sourceContentTransmissionForExecution` plus three secondary properties. grok's strong-objection on Q2: "Adds no new tuples beyond exhaustive examples already in `tests/unit/job-record.test.mjs`. The 1000-case budget buys ceremony." gpt-5.5-pro's missed-concern: fast-check needs pinned seed + shrinking log + per-architecture instantiation. This issue is the empirical probe: do property tests pay for themselves on this codebase?

## Acceptance criteria

1. `fast-check` added as devDep. Pinned version. Lockfile committed.

2. **One property test landed**, designed to NOT be ceremony:
   - `tests/property/redaction-edge-window.property.test.mjs`.
   - Generator: secret-shaped strings (random length 4-64, alphabets matching real OAuth/API key shapes), injected into provider response payloads at random positions including chunk boundaries.
   - Property: under any input, `redactValue(record)` produces output where the literal secret never appears as a substring of `result` or `error_message`, INCLUDING across rolling windows ≥ secret length (catches chunked-output split-boundary leaks the example tests in `job-record.test.mjs` don't cover).
   - This is the property grok would NOT call ceremony — it generates inputs the example tests can't enumerate.

3. **Pinned seed + shrinking log artifact:**
   - Seed pinned in source (e.g., `fc.assert(prop, { seed: 42, ... })`).
   - On failure: shrinking log written to `tmp/property-shrink-<test>.log` and uploaded as a CI artifact.
   - PR comment includes a one-liner "to reproduce: `npm test -- --grep '<test>' --seed=<failing-seed>`".

4. **Per-architecture instantiation:** the property runs three times — once per architecture's redaction surface (companion env-strip, grok output-time, api-reviewers output-time with both 4-char and 8-char thresholds). NOT a synthetic union.

5. **Empirical probe report after 1 month** (open as a follow-up issue at land time):
   - Did the property catch any bug the example tests missed? (Y/N + which.)
   - How many false-positive shrinks (cases the property flagged that turned out to be incorrect generators)?
   - Decision after data: keep, expand to JobRecord round-trip + external_review keys, or remove.

6. The other v2-proposed properties (`sourceContentTransmissionForExecution`, JobRecord round-trip, external_review keys) are explicitly DEFERRED in this issue. Grok's strong-objection stands until the redaction-edge property proves payoff.

## Code references

- grok's strong-objection on Q2: "no new tuples beyond exhaustive examples."
- grok's missed-concern: "fast-check becomes the first devDep with no pinned seed, no shrinking log artifact, and no strategy for reproducing a failing 1000-case run."
- gpt-5.5-pro's missed-concern: per-architecture instantiation.
- v2 spec § 8 redaction property (the only sub-property grok didn't attack).

## Out of scope

- Generic JobRecord/external_review/error_code property tests. Those are deferred until this probe shows pay-off.
- Rolling out fast-check to other repos.

## Why this is "optional, low priority"

- The two named regression tests (NAMED-TESTS.md) and the fixture-recording MVP (issue A) are higher leverage. Property tests pay off at the margin; named tests pay off concretely.
- If issues A through H all land but this one doesn't, #103 still closes.
- If this issue's probe shows the redaction-edge property catches no real bugs in 1 month, the right move is to remove it, not keep it as ceremony.

## Why we're doing it at all

- grok's verdict is "ceremony" only if the property is a weaker reimplementation of existing exhaustive tests. The redaction-edge-window property generates input shapes (split secrets across chunk boundaries) the example tests genuinely don't enumerate.
- It's the smallest test of the panel's disagreement. We have evidence; act on it.
