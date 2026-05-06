# Implementation plan — issue #103

This is the canonical operational document. Every other doc in `docs/` either grounds this plan (the audit layers) or is superseded by it (the v1/v2 specs). When the plan and a spec disagree, this plan wins.

## TL;DR

- Three architectures, not five: companion (claude/gemini/kimi), grok, api-reviewers.
- The single security-critical contract is `sourceContentTransmissionForExecution(status, errorCode, pidInfo)` — a deterministic 4-value enum mapping. Every other contract is per-architecture.
- 9 of 11 high-signal closed bugs already have direct semantic-match coverage. Only 2 genuine test gaps remain.
- The biggest unaddressed concern is fixture-recording infrastructure. Mocks vs real provider drift is the real #103 gap; addressing it requires user secrets + a deliberate recording cycle.
- 8 follow-up issues are queued (A–H), each with concrete acceptance criteria and effort estimates. Implementation happens in follow-up branches off `main`, not on this branch.

## What is decided

These items are out of scope for further debate; implement against them.

| Decision | Source | Why settled |
|---|---|---|
| 3 architectures, not 5 | Layer 1 | Code structure: companion plugins share JobRecord schema (byte-identical via sync); grok and api-reviewers each have their own output schema and redaction surface. Verified against canonical libs. |
| Per-plugin matrix shape, not Cartesian | Layer 1 + 2 + 3 | Per-architecture status enums and error_code enums diverge enough that ~70% of Cartesian cells are inapplicable. Per-plugin tuples + a small architecture-invariants block is the only workable shape. |
| Universal contract = `sourceContentTransmissionForExecution` | Layer 1 | The only invariant exhaustively shared across all three architectures. Already tested as exhaustive examples in `tests/unit/job-record.test.mjs`. |
| Regression-coverage signal = semantic-match, not citation | Layer 2 | Citation rule would have caught 1 of 11 closed bugs. Semantic-match catches 9. Confirmed by all 4 panel models. |
| Architecture invariants extracted from per-plugin matrix | Layer 4 panel (qwen) | Co-locating global law with local instances risks key shadowing and inflated blast radius. Extract to overlay. |
| Fixture-recording is required, not optional | Layer 4 panel (gpt-5.5-pro + 2 others) | "If #103's central concern is realism, deferring fixtures is hand-waving." Minimum: 1 success + 1 negative per architecture. |
| Wall-clock-based CI fails are forbidden | Layer 4 panel (gemini) | "Ticking time bomb. Will block emergency hotfix the morning a fixture ages out." Use bot status, not break the build. |
| `regression_signatures` curation by issue-closer = vacuous | Layer 4 panel (gemini) | Devs close bugs via `Fixes #N`; will not retroactively edit issue frontmatter. Replacement: extract signatures from PR diffs. |
| Honesty banner enforcement = warning, not CI fail | Layer 4 panel (gemini) | "Actively harmful — taxes honesty. Devs will create garbage issues OR stop writing 'DOES NOT PROVE' lines." Demote to bot-status check. |
| Doc-coverage via "mention anywhere" = theater | Layer 4 panel (grok + gemini) | Passes for commented-out blocks, deprecated docs, unrelated paragraphs. Replace with structured docstrings the AST can verify. |
| Property test on universal contract = ceremony unless per-architecture | Layer 4 panel (grok) | A property generating tuples from a synthetic union enum (that never occurs in any single plugin) is weaker than the existing exhaustive examples. Per-architecture instantiation OR drop. |
| 2 named regression tests, NOT exhaustive new tests | Layer 2 | Most invariants already have direct semantic-match coverage. The genuine gaps are Grok `models_ok_chat_400` (no smoke for 2-stage doctor probe) and `scope_total_too_large` manifest assertion. |
| docs/contracts/ sweep splits into 3 PRs, not 1 | Layer 4 panel (gpt-5.5-pro) | "One PR for nine doc completions is review-hostile. Atomic becomes junk drawer." Split: contracts, plugin/schema, CI/regression. |

## What is open

These need implementation signal before another design pass:

| Open question | Why deferred | Resolved by |
|---|---|---|
| Cache-update strategy for matrix gate (cron vs manual vs derived) | Multiple bad options; need real CI to evaluate | Issue B implementation |
| Bijective code↔matrix validator boundary | Where does it parse, what does it diff | Issue B implementation |
| Cross-architecture cache key salting scheme | Specific format for `arch:plugin:tuple_hash` | Issue B implementation |
| Per-PR flake gate threshold + bucketing | "Flake laundering" is real risk; need empirical threshold | Issue D implementation |
| Fixture-recording sanitization completeness | What constitutes "fully sanitized" varies per provider | Issue A first recording cycle |
| Whether property tests pay for themselves | Grok says ceremony; gpt-5.5-pro says fine if anchored properly. Implementation will tell. | Issue I (NEW — see below) |

## What we explicitly are NOT doing

- v3 spec rewrite. Diminishing returns. Future revisions track via individual follow-up issues, not whole-spec rewrites.
- Mutation testing on `plugins/*/scripts/lib/`. Panel rejected as wrong-next-move ("mostly proves you can mutate ambiguity").
- OS/Node matrix expansion. Out of scope per #103 non-goals; tracked separately if needed.
- Real provider quota in PR CI. Hard rule per #103.
- Live OAuth in PR CI. Same.

## Sequence of work

The follow-ups are roughly ordered by leverage and dependency. Each spawns its own branch from `main` and lands as its own PR.

```
A — fixture-recording MVP                  [BLOCKED on user secrets]
       │
       └──> H — fixture-freshness as bot-status (depends on A)

B — coverage matrix v2                     [unblocked]
C — regression-coverage linker (PR-diff)   [unblocked]
D — per-PR flake gate with bucketing       [unblocked]
E — doc-coverage via structured docstrings [unblocked]
F1, F2, F3 — doc-sweep items               [unblocked, parallel]
G — honesty banner as bot-status check     [unblocked]
I — property-test pay-for-itself probe     [unblocked, low priority]
```

Detailed acceptance criteria, code references, and effort estimates are in `docs/issues/<letter>-*.md`.

## Two named regression tests — drop-in for any branch

These are the only genuinely missing tests Layer 2 surfaced. Either of A or B branches above can pick them up; alternatively a tiny standalone branch lands them first.

### Grok `models_ok_chat_400` smoke

- File: `tests/smoke/grok-web.smoke.test.mjs`
- Test name: `doctor classifies models_ok_chat_400 when /models returns 200 but /chat/completions returns 400 with non-rejection body`
- Code under test: `chatBadRequestCode()` at `plugins/grok/scripts/grok-web-reviewer.mjs:622`
- Setup: mock tunnel returns 200 from `/v1/models` AND 400 with body that does NOT match the model-rejection pattern from `/v1/chat/completions`.
- Assertion: doctor result has `error_code === "models_ok_chat_400"`.
- Effort: ~30 min.

### Scope manifest in `scope_total_too_large` error_message

- This is a **feature add + test**, not just a test. Layer 2's #83 gap is that the recommendation behavior wasn't asserted. v2 panel (multiple) confirmed it should be in error_message, not just operator docs.
- Modify `plugins/grok/scripts/grok-web-reviewer.mjs` so the `scope_total_too_large` error path appends a deterministic, sorted file-size manifest to `error_message`.
- Add smoke test asserting the manifest format (top-N largest contributors, sorted descending by bytes, deterministic ordering for ties).
- Effort: ~45 min.

## How a fresh session picks up

1. Read `docs/STATUS.md` for branch state.
2. Read this file (IMPLEMENTATION-PLAN.md) for canonical decisions.
3. Read `docs/issues/EPIC-103.md` for epic boundaries and the issue index.
4. Pick a follow-up issue (`docs/issues/<letter>-*.md`) that's unblocked and start a branch.
5. Reference `docs/contracts/` for any contract you touch.
6. Reference `docs/path-maps/` for any flow you trace.
7. Reference `docs/closed-issue-failure-modes.md` for any bug-related work.

This file (IMPLEMENTATION-PLAN.md) is updated when a follow-up lands or when an open question gets resolved by implementation. v1 and v2 specs are NOT updated; they're frozen historical artifacts.
