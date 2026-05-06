# Follow-up issues — drafts

Drafts of GitHub issues for the #103 implementation epic. Drafted in-repo first so they're reviewable, gitTracked, and survive any GitHub-side ambiguity.

After user approval, each draft is opened on GitHub via `gh issue create`. The on-repo file stays for history; new sessions can read either source.

## Index

| File | Title | Status |
|---|---|---|
| [`EPIC-103.md`](./EPIC-103.md) | Epic — #103 implementation plan | drafted, awaiting user approval to file |
| [`A-fixture-recording-mvp.md`](./A-fixture-recording-mvp.md) | Fixture-recording MVP | drafted |
| [`B-coverage-matrix-v2.md`](./B-coverage-matrix-v2.md) | Coverage matrix v2 (per-plugin + bijective + salted) | drafted |
| [`C-regression-coverage-linker.md`](./C-regression-coverage-linker.md) | Regression-coverage linker via PR-diff extraction | drafted |
| [`D-flake-gate-bucketing.md`](./D-flake-gate-bucketing.md) | Per-PR flake gate with pass-rate threshold + bucketing | drafted |
| [`E-doc-coverage-structured.md`](./E-doc-coverage-structured.md) | Doc-coverage via structured docstrings | drafted |
| [`F-doc-sweep.md`](./F-doc-sweep.md) | docs/contracts/ completion sweep (6 items, 3 PRs) | drafted |
| [`G-honesty-banner.md`](./G-honesty-banner.md) | Honesty banner as bot-status check | drafted |
| [`H-fixture-freshness.md`](./H-fixture-freshness.md) | Fixture-freshness as bot-status check | drafted |
| [`I-property-test-probe.md`](./I-property-test-probe.md) | Property-test pay-for-itself probe (optional) | drafted |
| [`NAMED-TESTS.md`](./NAMED-TESTS.md) | Two named regression tests (drop-in) | drafted |

## How to use

- **Read EPIC-103.md first.** It anchors all the others.
- **Pick one issue letter and open its file.** Each is self-contained: title, acceptance criteria (testable), code references, effort estimate, blocking conditions, panel-source.
- **Start a branch for that issue from `main`** (not from `feat/103-robustness-spec`). The audit branch contains plan + audit only; implementation branches are atomic per issue.
- **Reference `docs/IMPLEMENTATION-PLAN.md`** for cross-cutting decisions that apply.
- **When the issue lands, update `IMPLEMENTATION-PLAN.md`'s "What is open" table** if your implementation resolved any open question.
