# CI smoke-test robustness — design spec

- **Issue:** [#103 — Strengthen CI smoke-test robustness across reviewer plugins](https://github.com/seungpyoson/codex-plugin-multi/issues/103)
- **Branch:** `feat/103-robustness-spec`
- **Date:** 2026-05-06
- **Status:** Draft for adversarial review
- **Target delivery:** One focused day for the framework + audit + highest-leverage assertion fixes; bulk smoke rewrites and real-fixture recordings explicitly deferred.

## 1. Problem

The repo ships five reviewer plugins (`claude`, `gemini`, `kimi`, `grok`, `api-reviewers`) and ~12.6k lines of smoke tests across `tests/smoke/`. CI runs a 5-way smoke matrix plus a unit job under hostile git env plus a coverage gate. Smoke tests spawn real local CLI entrypoints with mocked providers.

Issue #103 lists four specific gaps:

1. Mocks do not prove real provider/OAuth/session behavior end to end.
2. Smoke can pass while actual provider output diverges from mock output.
3. Historical reviewer findings are not guaranteed to have a named regression test.
4. Robustness is not reported as a coverage matrix; pass/fail can be mistaken for stronger evidence than it is.

Net: smoke-pass is currently *plausible* coverage, not *audited* coverage. There is no gate that fails when a known failure mode is unprotected.

## 2. Definition: what "robust" means for a CI test in this repo

A test is robust to the degree it produces non-fakeable evidence that a named production-relevant failure mode cannot silently regress. Ten measurable dimensions:

1. **Specificity.** The test names the failure mode it catches (issue #, PR #, contract). Deleting the test makes a specifiable bug invisible.
2. **Falsifiability.** Assertions are shape-specific (`error_code === "auth_failure"`, `lifecycle.length === 4`), not tautological (`assert.ok(result)`).
3. **Mock fidelity.** Mocks are pinned to recorded real provider output with provenance (model id, recorded date, prompt hash, sanitization notes). Stale fixtures fail a freshness gate.
4. **Boundary discipline.** Smoke spawns the actual CLI entrypoint; unit tests import.
5. **Negative-path parity.** Every happy path has a paired failure path covering: bad args, auth failure, missing binary, malformed provider output, timeout, scope failure, prelaunch source-not-sent, secret redaction.
6. **Adversarial inputs from incidents.** Tests are written from the closed-bug list, not a clean-room test plan.
7. **Determinism.** Each smoke test is provably non-flaky under N-times repetition.
8. **Coverage observability.** Build emits a `plugin × flow × failure-mode` matrix with each cell either a test reference, an explicit `uncoverable: <reason>`, or a build-failing `UNFILLED`.
9. **Drift detection.** Public contracts (JobRecord, lifecycle order, error_code enum, redaction surface, source-transmission disclosure) each have a contract test that fails when fields are added/removed/renamed.
10. **Honesty.** CI output prints what smoke proves and what it does not.

These ten dimensions are the audit rubric in section 5 and the enforcement targets in section 6.

## 3. Strategy chosen: B (matrix + teeth) within #103 constraints

Three strategies were considered:

- **A. Visibility-only** — matrix + linker + recorded fixtures + honesty banner. Solves #103's letter, not its spirit.
- **B. Matrix + teeth** *(chosen)* — A plus property-based contract tests, in-process chaos injection, flake gate, weekly gated fixture re-record canary.
- **C. Full** — B plus mutation testing on `plugins/*/scripts/lib/`, OS matrix expansion, real CLI version matrix.

B is the credible ceiling under #103's constraint that ordinary PR CI must not spend real model quota. A is half a solution; the matrix without teeth becomes green-cell theatre. C's mutation testing is the right idea but premature — it requires a baseline of non-tautological assertions, which B establishes.

## 4. Architecture

```
   ┌─────────────────────────────────┐
   │  tests/coverage-matrix.yml      │  single source of truth: which
   │  plugin × flow × mode × case    │  (plugin,flow,mode,case) tuples
   └──────────────┬──────────────────┘  exist, and how each is covered
                  │ (cells reference tests by path::name)
                  │
                  ├─ tests/smoke/      *.smoke.test.mjs
                  ├─ tests/property/   *.property.test.mjs   (fast-check invariants)
                  ├─ tests/chaos/      *.chaos.test.mjs      (in-process fault injection)
                  └─ tests/smoke/fixtures/<plugin>/*.{response,provenance}.json

   GATES (CI lint job; build fails on any violation):
     scripts/ci/check-coverage-matrix.mjs   bare UNFILLED → fail
                                            unfilled_tracked: #N → pass
                                            test: ref must resolve to real test
     scripts/ci/check-regression-tests.mjs  closed bug-labeled issue without
                                            citing test → fail (unless exempt)
     scripts/ci/check-fixture-freshness.mjs warn on stale_after past now

   GATES (separate workflows):
     .github/workflows/flake-gate.yml       nightly 20× rerun → fail on any
                                            non-deterministic outcome

   OUTPUT:
     Honesty banner appended to every smoke job log (what smoke proves /
     does not prove on this run).
```

Components:

- **Coverage matrix** (`tests/coverage-matrix.yml`) — the audit surface. Row = `(plugin, flow, mode, case)`. Cell = one of `{ test: <file>::<test-name>, uncoverable: <reason> #NNN, unfilled_tracked: <issue #> }`. Build fails on bare UNFILLED or on dangling test refs.
- **Matrix gate** (`scripts/ci/check-coverage-matrix.mjs`) — parses the matrix, validates every `test:` reference resolves to an actual test, fails on bare UNFILLED. Wired into `npm run lint`.
- **Regression-test linker** (`scripts/ci/check-regression-tests.mjs`) — iterates closed issues with bug-shaped labels via `gh issue list`, requires each to be cited in some `tests/**/*.mjs` file via `// regression: #NNN` or describe-block. Cached locally; runs in CI.
- **Property-based tests** (`tests/property/`) — uses `fast-check` (devDep, ~200kB). Covers invariants on JobRecord shape, lifecycle event ordering, redaction (no secret-shaped substrings ever appear in stdout/stderr under fuzzed input).
- **Chaos harness** (`tests/chaos/`) — in-process fault injection. Three initial scenarios mapped to closed bugs.
- **Flake gate** (`npm run test:flake`) — invokes the smoke matrix N times in a separate workflow on a nightly cron, fails on any non-deterministic outcome.
- **Fixture provenance** (`tests/smoke/fixtures/<plugin>/<scenario>.{response,provenance}.json`) — schema for recorded provider responses; stub `npm run smoke:rerecord` workflow gated by `workflow_dispatch` + secrets. Recording itself is out of scope today.
- **Honesty banner** — every smoke job appends a deterministic block to its log: what smoke proves, what it does not.

## 5. Per-test audit (Phase 1)

**Deliverable:** `docs/superpowers/specs/2026-05-06-ci-robustness-audit.md`

For each of the five smoke test files, score the file against the ten dimensions, producing concrete findings:

```markdown
## tests/smoke/claude-companion.smoke.test.mjs
- **Specificity:** N tests cite an issue/PR; M tests do not. Findings list per uncited test.
- **Falsifiability:** N assertions are shape-specific; M are tautological (assert.ok, assert.equal(x, x)). Findings list per tautological assertion with file:line.
- **Mock fidelity:** mock at tests/smoke/claude-mock.mjs has no provenance.json. → matrix row "uncoverable until fixture recording lands (#NNN)".
- **Negative-path parity:** Failure modes covered: [...]; missing: [bad args, auth-fail, ...]. Each missing → matrix row UNFILLED.
- **Boundary discipline:** spawns plugin entrypoint via execFile? yes/no.
- **Determinism:** flake risks identified by inspection.
```

Scoring rules:

- A finding becomes one of: (a) a fix landed today, (b) a matrix cell `uncoverable: <reason> #NNN` (covered by an explicit reason that itself references the tracking issue), (c) a matrix cell `unfilled_tracked: <open follow-up issue #>` (acknowledged gap, gate passes), or (d) a bare UNFILLED cell. We do not ship with bare UNFILLED — every gap is at minimum `unfilled_tracked`.
- Tautology fixes are time-boxed: hard cap of 20 assertions today; the rest become numbered sub-bullets in the consolidated follow-up issue (per global rule 11).

## 6. Coverage matrix — schema and gate

`tests/coverage-matrix.yml`:

```yaml
version: 1
plugins:
  - name: claude
    flows: [run, review, custom-review, adversarial-review, ping, doctor, status, result, cancel, continue]
    modes: [foreground, background]
  - name: gemini
    flows: [run, review, custom-review, adversarial-review, ping, status, result, cancel]
    modes: [foreground, background]
  - name: kimi
    flows: [run, review, custom-review, adversarial-review, ping, status, result, cancel]
    modes: [foreground, background]
  - name: grok
    flows: [run, review, custom-review, adversarial-review, status, result, cancel]
    modes: [foreground]    # background not supported per current architecture
  - name: api-reviewers
    flows: [deepseek-review, deepseek-adversarial-review, deepseek-custom-review, glm-review, glm-adversarial-review, glm-custom-review]
    modes: [foreground]

cases:
  # "case" covers both happy paths and failure modes
  - happy_path
  - bad_args
  - auth_failure
  - missing_binary
  - provider_unavailable
  - malformed_provider_output
  - timeout
  - cancellation
  - scope_failure
  - source_not_sent_on_prelaunch_failure
  - lifecycle_json_ordering
  - jobrecord_shape
  - secret_redaction
  - packaged_copy_drift

coverage:
  # Each cell has exactly one of: test | uncoverable | unfilled_tracked
  # Any (plugin, flow, mode, case) tuple absent from coverage = bare UNFILLED → gate fails.
  - plugin: claude
    flow: run
    mode: foreground
    case: happy_path
    test: "tests/smoke/claude-companion.smoke.test.mjs::run happy path emits queued→running→completed"
  - plugin: claude
    flow: run
    mode: foreground
    case: malformed_provider_output
    uncoverable: "requires recorded provider fixture — see follow-up issue #NNN"
  - plugin: kimi
    flow: review
    mode: background
    case: timeout
    test: "tests/smoke/kimi-companion.smoke.test.mjs::review times out per #41"
  - plugin: grok
    flow: adversarial-review
    mode: foreground
    case: secret_redaction
    unfilled_tracked: 104  # tracked in Phase-2 follow-up; gate passes
  # ... every (plugin, flow, mode, case) tuple appears here exactly once
```

Gate (`scripts/ci/check-coverage-matrix.mjs`):

1. Parse matrix YAML. Schema-validate.
2. Enumerate full Cartesian product `plugins.flows × plugins.modes × cases`.
3. For each tuple: require it appear in `coverage:` exactly once with exactly one of `test`, `uncoverable`, or `unfilled_tracked`. Tuple absent from `coverage:` is treated as bare UNFILLED.
4. For each `test:` cell: require the file exists and the test-name is grep-matchable in that file.
5. For each `uncoverable:` cell: require the reason references a tracking issue `#NNN`.
6. For each `unfilled_tracked:` cell: require the value is a positive integer issue number AND that issue exists and is open (verified via `gh issue view <N>`; cached locally).
7. Exit non-zero on any bare UNFILLED, on any unresolvable test reference, on any closed `unfilled_tracked` issue, or on any malformed cell.
8. Print a one-line summary: `coverage: X/Y tuples covered, W uncoverable, V tracked-unfilled, U bare-UNFILLED.`

Wire into `package.json` as `lint:coverage-matrix` and into the existing CI `lint` job.

## 7. Regression-test linker

`scripts/ci/check-regression-tests.mjs`:

1. `gh issue list --state closed --label bug --limit 200 --json number,title` (cached locally for offline `npm test`).
2. Grep `tests/**/*.mjs` for `// regression: #NNN` markers and `regression: #NNN` substrings inside `t.test(...)` titles.
3. For every closed bug-issue, require ≥1 reference. Missing references fail the gate with explicit "issue #NNN has no regression test".
4. Allow opt-out via `tests/regression-exemptions.yml` listing `{issue: NNN, reason: "uncoverable in CI because X"}`. Reason must be specific.

Wire into CI `lint` job. First run on this branch may surface dozens of missing references — those become matrix UNFILLED rows or exemptions, not silent passes.

## 8. Property-based contract tests

Devdep: `fast-check` (~200kB, MIT, no transitive deps).

`tests/property/jobrecord.property.test.mjs`:

- Generator: arbitrary objects shaped like JobRecord (id, plugin, flow, status, lifecycle[], error_code?, ...).
- Property 1: every JobRecord written by any plugin's `record()` helper round-trips through `parse()` losslessly.
- Property 2: `status` ∈ `{queued, running, completed, failed, cancelled}` always.
- Property 3: if `status === "failed"`, `error_code` is a non-empty string from a fixed enum.

`tests/property/lifecycle.property.test.mjs`:

- Property 1: lifecycle events are strictly ordered by `at` timestamp.
- Property 2: every JobRecord has a `queued` event and either a `completed`, `failed`, or `cancelled` event — never both completion and cancellation.
- Property 3: lifecycle is monotonic — no event type appears after a terminal event.

`tests/property/redaction.property.test.mjs`:

- Generator: random secret-shaped strings (sk-*, gh*, eyJ-prefix JWTs, AKIA-prefix, etc.) injected into prompts/env.
- Property: under any input, `record.stdout` and `record.stderr` never contain the literal secret. Only the redacted form appears.

Each property runs ≥1000 cases per CI run; failing case is shrunk and printed.

## 9. Chaos harness

`tests/chaos/harness.mjs` — in-process fault injection helpers: `killChildAfter(ms)`, `corruptJsonAfter(bytes)`, `slowProvider(ms)`, `oversizedScope(N)`, `expiredOAuth()`.

Three initial scenarios, each mapped to a closed bug:

- `tests/chaos/kill-mid-stream.chaos.test.mjs` — spawns plugin run, kills child after 200ms, asserts JobRecord ends `failed` with `error_code === "child_killed"` and lifecycle has no orphan `running`. Exercises the non-approval-failure surface that issue #77 (reviewer runtime logs for non-approval failures) wants logged; verifies the failure shape, not the log content #77 specifies.
- `tests/chaos/malformed-json.chaos.test.mjs` — provider mock returns truncated JSON mid-array, asserts JobRecord ends `failed` with `error_code === "parse_error"` and stderr contains the byte offset. Maps to issue #52 (Kimi non-JSON parse_error).
- `tests/chaos/oversized-scope.chaos.test.mjs` — scope diff exceeds budget, asserts prelaunch denial fires before any provider call, no source bytes sent. Maps to issue #83 (oversized branch-diff before provider launch).

Each chaos test is also a regression test (cites the closed bug). Future chaos scenarios become matrix rows; we don't need to map every failure mode to a chaos test, only the ones where in-process fault injection is the cleanest evidence.

## 10. Flake gate

`scripts/ci/run-tests-repeat.mjs`:

- Args: `--target=<smoke target> --times=<N>`.
- Runs the target N times serially. Captures pass/fail per run.
- Exits non-zero if any run differs in pass/fail outcome from the others, or if pass-rate < 100%.

`.github/workflows/flake-gate.yml`:

- `on: schedule: - cron: '0 7 * * *'` (07:00 UTC daily; off-peak for ubuntu-latest runners). Also `on: workflow_dispatch:` so it can be triggered manually.
- Matrix over the 5 smoke targets.
- Calls `node scripts/ci/run-tests-repeat.mjs --target=<t> --times=20`.
- Surfaces failing test name + run number on flake.

20× was chosen because at that depth the chance of a 5%-flaky test passing all 20 runs is ~36% — small enough to catch persistent flakes within ~3 nightly runs. Tunable.

## 11. Fixture provenance

`tests/smoke/fixtures/<plugin>/<scenario>.response.json` — sanitized provider response.

`tests/smoke/fixtures/<plugin>/<scenario>.provenance.json`:

```json
{
  "model_id": "claude-opus-4-7",
  "recorded_at": "2026-05-06T12:00:00Z",
  "prompt_hash": "sha256:...",
  "sanitization_notes": "redacted: api_key, oauth_token, user.email",
  "recorded_by": "manual: workflow_dispatch run #42",
  "stale_after": "2026-08-06T12:00:00Z"
}
```

Freshness gate (`scripts/ci/check-fixture-freshness.mjs`): warns (does not fail) when `stale_after` is in the past. Failure escalation deferred until first re-record cycle exists.

`scripts/smoke-rerecord.mjs` + `.github/workflows/smoke-rerecord.yml` — `workflow_dispatch` only, gated by per-plugin secrets, sanitizes responses, opens a PR with diff. **Today: stub workflow + script skeleton + sanitization library; no actual recording.** Real recording lands in a follow-up gated by user-provided credentials.

## 12. Honesty banner

Every smoke job appends to its CI log:

```
================================================================
SMOKE PROVES:
  - Local CLI entrypoint spawns and exits with expected code
  - Mocked/replayed provider response is consumed correctly
  - JobRecord shape, lifecycle ordering, redaction invariants hold

SMOKE DOES NOT PROVE:
  - Live provider auth (no real OAuth this run)
  - Real model output correctness (response is from fixture)
  - Fixture freshness beyond <stale_after> (last recorded <recorded_at>)
  - OS coverage outside ubuntu-latest
================================================================
```

Implemented as a final step in each smoke matrix job.

## 13. Scope cuts and follow-ups

**Out of scope today, tracked as one consolidated follow-up issue (per global rule 11):**

- Real provider fixture recording (requires user secrets + deliberate run).
- Bulk rewrite of existing tautological assertions beyond the 20-fix cap.
- Mutation testing (Strategy C).
- OS/Node version matrix expansion.
- Real CLI version matrix.
- Failure-escalation tightening of fixture freshness gate.
- Any matrix UNFILLED rows that survive today's audit.

The follow-up issue title is `Strengthen CI smoke-test robustness — Phase 2`. Sub-bullets enumerate every deferred item.

## 14. Acceptance criteria

The branch is mergeable when all of the following are true:

1. `tests/coverage-matrix.yml` exists. `npm run lint:coverage-matrix` parses it, validates Cartesian completeness, and exits 0. Each tuple resolves to exactly one of `test:` (covered), `uncoverable: <reason> #NNN` (covered by reason), or `unfilled_tracked: <open issue #N>` (gap acknowledged, gate passes). No bare UNFILLED tuples remain; every `unfilled_tracked` references an open issue from this branch's consolidated follow-up filing.
2. `scripts/ci/check-regression-tests.mjs` exists, runs in CI `lint`, and either passes or every failure is exempted in `tests/regression-exemptions.yml` with a specific reason.
3. `tests/property/jobrecord.property.test.mjs`, `tests/property/lifecycle.property.test.mjs`, `tests/property/redaction.property.test.mjs` exist, each runs ≥1000 cases, all pass.
4. `tests/chaos/kill-mid-stream.chaos.test.mjs`, `tests/chaos/malformed-json.chaos.test.mjs`, `tests/chaos/oversized-scope.chaos.test.mjs` exist, each cites the mapped closed bug, all pass.
5. `.github/workflows/flake-gate.yml` exists with cron schedule, targets the 5 smoke jobs, repetition count = 20.
6. Fixture provenance schema is documented; sanitization library and rerecord stub workflow exist with no real recording yet.
7. Every smoke job emits the honesty banner in its log.
8. `docs/superpowers/specs/2026-05-06-ci-robustness-audit.md` exists and lists per-file findings against the 10 dimensions.
9. Existing `npm test`, `npm run test:full`, `npm run lint`, `npm run lint:sync` all pass.
10. The follow-up consolidated issue is filed listing every deferred item with concrete numbered sub-bullets.

## 15. Non-goals

- Spending real model quota in ordinary PR CI.
- Live OAuth/browser/provider sessions in every PR.
- Replacing external latest-head review gates where required by process.
- Rewriting the existing smoke test suite's assertions in bulk.
- Validating real-model output correctness on every PR.

## 16. Risks

- **Regression-linker false positives.** Closed `bug`-labeled issues that aren't actually testable (docs bugs, infra) will fail the gate. Mitigation: `tests/regression-exemptions.yml` with explicit reason.
- **Property-test flake.** `fast-check` shrinking can be slow; 1000 cases may push CI runtime. Mitigation: cap per-test timeout, treat any flake as a real determinism finding under dim. 7.
- **Chaos-test platform sensitivity.** `killChildAfter` timing on macOS vs ubuntu can differ. Mitigation: assert on outcome (lifecycle terminal state) not timing.
- **Matrix maintenance burden.** New flows or failure modes require matrix updates. Mitigation: this is the point — the matrix is the audit surface. New flow without a matrix row = test gap.
- **Fixture rerecord is stub-only today.** The biggest single piece of #103's spirit (mock-vs-real divergence) remains unaddressed in PR CI until recording lands. Mitigation: explicit honesty banner; consolidated follow-up issue with a concrete first re-record cycle plan.
- **Audit cap of 20 tautology fixes is arbitrary.** May leave high-leverage findings unfixed. Mitigation: prioritize by impact (assertions in tests citing closed bugs first); rest go to follow-up.

## 17. Open questions for adversarial review

These are the specific decisions most likely to be wrong. Reviewers should attack them directly:

1. **Strategy choice (B vs A vs C).** B claims to be the "credible ceiling under #103 constraints." Is it actually? Or is C's mutation testing more important than property/chaos because it directly answers "do my assertions have teeth"?
2. **Stub-only fixture recording today.** Today's deliverable does not actually record a single real-provider response. Is that an honest cut or a fig leaf — does the spec defer the only thing that addresses #103's first stated gap?
3. **20× flake gate at nightly cadence.** Adequate? Should it be per-PR? Should N be 50 or 100? Cost-vs-detection trade-off.
4. **Property tests at 1000 cases.** Adequate, or theatrically high? Is `fast-check` the right tool, or is JSON-Schema-based contract testing simpler and equivalent?
5. **Chaos scenarios = 3.** Closed-bug-mapped, but only 3. Is that meaningful coverage or token effort? Should we require a chaos scenario per failure-mode column?
6. **Matrix shape: YAML.** Machine-readable, gates well, less browsable. Issue #103 says "machine-readable or Markdown." Was YAML the right call vs a Markdown table generated from YAML?
7. **Regression-linker: closed-issues-with-bug-label.** What about closed issues without a label, or PR-only fixes that never had an issue? Linker may miss real bugs.
8. **In-scope-today claim.** Is this actually a one-day deliverable, or am I shipping a half-baked framework that violates "80% done is 0% done"? Where does it slip?
9. **Honesty banner placement.** As a CI log footer is informational. Should it block the merge if any "DOES NOT PROVE" item is later proven false (e.g., fixture is stale)?
10. **Three plugins (api-reviewers) collapse two providers (deepseek + glm) into one matrix row group.** Is that hiding asymmetric coverage gaps?
