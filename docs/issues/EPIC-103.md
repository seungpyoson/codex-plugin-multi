# Epic — #103 implementation

> **This is the epic body, drafted in-repo for review before being filed on GitHub. After your approval, this gets posted as a new issue with `epic` label, and #103 is updated to reference it.**

## Boundaries

### What this epic owns

- Bringing CI smoke tests to a "non-fakeable evidence" standard for all five reviewer plugins.
- Producing an auditable coverage matrix that the build can fail on.
- Closing the two genuine test gaps Layer 2 surfaced (Grok `models_ok_chat_400`, scope-manifest assertion).
- Establishing fixture-recording infrastructure (sanitization, replay, gated re-record).
- Documenting all canonical contracts in `docs/contracts/` to a structured-docstring standard.
- Adding determinism gates (per-PR flake rerun + nightly larger rerun) with bucketing — not flake laundering.

### What this epic does NOT own

- v3 spec rewrite. Spec iteration hit diminishing returns at v2; further design happens in individual follow-up issues, not whole-spec rewrites.
- Mutation testing on `plugins/*/scripts/lib/`. Panel rejected as the wrong next move.
- OS/Node matrix expansion or real CLI version matrix. #103 non-goals.
- Real model quota in PR CI. Hard rule.
- Live OAuth/browser/provider sessions in every PR. Hard rule.

## Current state (snapshot at branch `feat/103-robustness-spec`)

The branch contains an audit-and-plan, not implementation. Specifically:

- **Layer 1 — `docs/contracts/`.** Source-of-truth schemas with file:line citations: JobRecord, external-review sub-record + source-transmission enum + disclosure templates, lifecycle events, redaction (3 mechanisms), grok output, api-reviewers output. ~7 docs.
- **Layer 2 — `docs/closed-issue-failure-modes.md`.** All 48 closed issues audited via semantic-match (failure-signature strings in tests, NOT issue # citations). 9 of 11 high-signal bugs have direct coverage; 2 real test gaps surfaced. Has a "How to use this" section with operational rules.
- **Layer 3 — `docs/path-maps/`.** End-to-end call-graph traces for each architecture: companion (claude/gemini/kimi), grok, api-reviewers. Has navigational README with operational rules.
- **Layer 4 — `docs/IMPLEMENTATION-PLAN.md`.** Canonical front-door doc. What's decided, what's open, what's next.
- **`docs/STATUS.md`.** Branch state and reading order for new sessions.
- **Two superseded specs** at `docs/superpowers/specs/2026-05-06-ci-robustness-design{,-v2}.md`. Historical only — IMPLEMENTATION-PLAN.md supersedes.

## What's been decided (interpretations from the audit)

- 3 architectures, not 5. Companion (claude/gemini/kimi) shares JobRecord schema. grok and api-reviewers each have own output schemas.
- Universal contract is `sourceContentTransmissionForExecution(status, errorCode, pidInfo) → 4-value enum`. Already exhaustively tested as examples.
- Per-plugin matrix shape (NOT Cartesian). Architecture invariants extracted to overlay (per qwen).
- Regression-coverage signal = semantic-match (NOT citation). Citation rule would have caught 1 of 11 closed bugs.
- Wall-clock CI fails are forbidden — bot-status checks instead.
- `regression_signatures` curation by issue-closer is vacuous (gemini); replacement = PR-diff extraction.
- Honesty-banner enforcement is actively harmful (gemini); demote to bot-status check.
- Doc-coverage "mention anywhere" is theater (grok + gemini); replace with structured docstrings the AST can verify.
- Property test on universal contract is ceremony unless per-architecture instantiated (grok); needs pinned seed + repro strategy.
- 2 named regression tests, NOT exhaustive new tests.
- `docs/contracts/` sweep splits into 3 PRs, not 1 (gpt-5.5-pro).
- Fixture-recording is the central #103 concern (gpt-5.5-pro + 2 others); minimum 1 success + 1 negative per architecture.

## Sequence of follow-up issues

Each follow-up has its own draft in `docs/issues/<letter>-*.md` with concrete acceptance criteria, code references, effort estimate, and blocking conditions.

| Letter | Title | Effort | Blocked on |
|---|---|---|---|
| **A** | Fixture-recording MVP | ~6-8 hours | repo secrets + deliberate workflow_dispatch run |
| **B** | Coverage matrix v2 (per-plugin + bijective validator + cross-arch hash salting) | ~4 hours | nothing |
| **C** | Regression-coverage linker via PR-diff extraction | ~3 hours | nothing |
| **D** | Per-PR flake gate with pass-rate threshold + bucketing | ~3 hours | nothing |
| **E** | Doc-coverage via structured docstrings | ~4 hours | nothing |
| **F** | docs/contracts/ completion sweep — 6 remaining items, split into 3 PRs | ~6 hours total | nothing |
| **G** | Honesty banner as bot-status check (not CI fail) | ~2 hours | nothing |
| **H** | Fixture-freshness as bot-status (not wall-clock CI fail) | ~2 hours | A first |
| **I** | Property-test pay-for-itself probe (low priority, optional) | ~3 hours | nothing |

Plus one orthogonal item that can ride on any of these branches:

- **Two named regression tests** drop-in (Grok `models_ok_chat_400`, scope manifest). See `docs/issues/NAMED-TESTS.md` for spec. ~75 min combined.

## Panel signal

This epic was scoped after a 4-model adversarial review of spec v2 (`gpt-5.5-pro` via OpenRouter, `grok-4.3`, `gemini-3.1-pro-preview`, `qwen3.6-max-preview` via OpenRouter). Reviews are not committed verbatim (token cost), but the panel verdicts and missed-concerns drove the decisions table above. If you want to re-run the panel against any specific follow-up, use the prompts at `docs/superpowers/specs/2026-05-06-ci-robustness-design-v2.md` § 17 as the template.

## Acceptance criteria for closing this epic

- [ ] `docs/IMPLEMENTATION-PLAN.md`'s "What is decided" table has zero TODOs.
- [ ] `docs/IMPLEMENTATION-PLAN.md`'s "What is open" table has zero rows (every open question resolved by an implemented follow-up).
- [ ] All 9 follow-up letters (A–I) closed.
- [ ] The two named regression tests landed.
- [ ] At least one fixture recorded per architecture (3 minimum: companion, grok, api-reviewers).
- [ ] `docs/contracts/` lints under structured-docstring coverage (issue E).
- [ ] CI emits a coverage matrix summary line on every smoke run.
- [ ] Original issue #103's six acceptance criteria from its body are individually satisfied (cross-reference in closing comment).
