# CI smoke-test robustness — design spec (v2)

- **Issue:** [#103 — Strengthen CI smoke-test robustness across reviewer plugins](https://github.com/seungpyoson/codex-plugin-multi/issues/103)
- **Branch:** `feat/103-robustness-spec`
- **Date:** 2026-05-06
- **Status:** Draft for adversarial review (panel: gpt-5.4-pro, grok-4.3, gemini-3.1-pro-preview + one substitute for deepseek)
- **Replaces:** `2026-05-06-ci-robustness-design.md` (v1). v1 was authored before grounding work; the internal adversarial review and the four-layer audit (contracts → archaeology → path-maps) surfaced enough corrections to warrant a clean revision rather than incremental edits.

## Grounded evidence this spec is built on

This spec is constructed *from* the layered audit, not from #103 prose alone. Every claim below cites the layered doc that grounds it:

- **Layer 1 contracts** — `docs/contracts/{job-record,external-review,lifecycle-events,redaction,grok-output,api-reviewers-output}.md`. Source-of-truth schemas with file:line citations into the canonical libraries.
- **Layer 2 archaeology** — `docs/closed-issue-failure-modes.md`. All 48 closed issues audited via semantic-match (not citation) for regression-test coverage. 9 of 11 high-signal bugs already have direct coverage; 2 are real gaps.
- **Layer 3 path maps** — `docs/path-maps/{companion,grok,api-reviewers}.md`. End-to-end call-graph trace of every `cmd<Flow>` function, with state mutations, failure modes, and test references at every step.

## 1. Problem (re-framed)

Issue #103 identifies four gaps. After grounding, the gaps look different from how v1 read them:

| #103 stated gap | What it actually looks like in the codebase |
|---|---|
| Mocks don't prove real provider/OAuth/session behavior end to end | True. No fixture-recording infrastructure exists; smoke tests use hand-written mocks. Real-provider drift is undetected. |
| Smoke can pass while actual provider output diverges from mock output | Same root cause as above. Distinct tracking only useful if recording lands. |
| Historical reviewer findings not guaranteed to have a named regression test | Mostly false. Layer 2 shows 9 of 11 high-signal bugs have direct semantic-match coverage. The "named" requirement (issue # citation) is what fails — only 1 of 11 has an explicit citation. |
| Robustness not reported as a coverage matrix | True. No matrix exists. v1 proposed Cartesian; grounded data shows it must be per-plugin. |

Net: two real gaps (fixture fidelity, observability matrix), one perceived gap that's actually a labeling problem (regression citations), one consequence of the first.

## 2. Definition: what "robust" means for a CI test in this repo

(Unchanged from v1. The 10 dimensions held up under archaeology.)

A test is robust to the degree it produces non-fakeable evidence that a named production-relevant failure mode cannot silently regress.

1. **Specificity** — names the failure mode it catches (issue, contract, named symbol).
2. **Falsifiability** — assertions are shape-specific, not tautological.
3. **Mock fidelity** — mocks pinned to recorded real provider output with provenance (model id, recorded date, prompt hash, sanitization notes).
4. **Boundary discipline** — smoke spawns the actual CLI entrypoint; unit tests import.
5. **Negative-path parity** — every happy path has a paired failure path covering applicable failure modes (note: applicable list varies per architecture per Layer 1).
6. **Adversarial inputs from incidents** — tests written from the closed-bug list.
7. **Determinism** — provably non-flaky under N×repetition.
8. **Coverage observability** — build emits a per-plugin × applicable-flow × applicable-case matrix.
9. **Drift detection** — public contracts have shape-tests that fail when fields are added/removed/renamed.
10. **Honesty** — CI output prints what smoke proves and what it does not.

## 3. Strategy: B (matrix + teeth) — refined

V1 chose B. Layers 1-3 confirm it remains the right strategy *under the same #103 constraints*, but with materially different content. The biggest refinements:

- **Drop the universal-Cartesian matrix.** Per-plugin tuples only. The three architectures have different status enums, different error_code enums, different applicable failure modes. v1's Cartesian created ~1000 mostly-impossible cells.
- **Drop the citation-based regression linker.** Use semantic-match, not citation. v1's rule would have caught 1 of 11 high-signal bugs.
- **Add only TWO named regression tests** (down from "exhaustive new tests"). Layer 2 archaeology proved coverage is already broad; only 2 specific gaps need filling.
- **Anchor property-based tests on the universal contract.** `sourceContentTransmissionForExecution` from `external-review.mjs` is the only invariant exhaustively shared across all three architectures and all error-code enums. Property test there → universal coverage. Per-plugin status/error_code enums diverge too much for a single property.
- **Add a `docs/contracts/` completion sweep.** Layer 2 found that "spec gaps dominate test gaps" — most invariants are tested but undocumented. Layer 1 captured 70% of the contract surface; the remaining 30% are named in Layer 2's `spec_gap` column.

## 4. Architecture

```
   ┌──────────────────────────────────────────────────────────┐
   │ tests/coverage-matrix.yml                                │
   │   per-plugin: { name, applicable-flows, applicable-cases │
   │                 (each cell: test|uncoverable|tracked)    │
   │   per-architecture-family: shared invariants (the few    │
   │                            cross-cutting cells)          │
   └──────────────────────────┬───────────────────────────────┘
                              │
       ┌──────────────────────┼──────────────────────────────┐
       ▼                      ▼                              ▼
  tests/smoke/         tests/property/                tests/chaos/
  (existing)        property-based on                 in-process fault
                    sourceContentTransmissionFor      injection (3 named)
                    Execution + JobRecord shape +
                    redaction surfaces
                              │
                              ▼
   GATES (CI lint job):
     check-coverage-matrix.mjs       — bare UNFILLED → fail
     check-regression-coverage.mjs   — semantic-match against
                                       closed bug-labeled issues; opt-out file
     check-fixture-freshness.mjs     — warn (no fail) on stale_after past now
     check-contracts-doc-coverage.mjs — every JobRecord/external_review/
                                       error_code field cited in
                                       docs/contracts/

   GATES (separate workflows):
     .github/workflows/flake-pr.yml      — per-PR 5× rerun on changed
                                           smoke targets
     .github/workflows/flake-nightly.yml — nightly 20× rerun on full
                                           smoke matrix

   OUTPUT:
     Honesty banner per smoke job — what smoke proves AND what it
     does NOT prove. "DOES NOT PROVE" lines reference open follow-up
     issues; closing the issue auto-removes the line via gate.
```

## 5. Per-test audit (Phase 1 — already done as Layer 2)

`docs/closed-issue-failure-modes.md` is the audit deliverable. v1 proposed this; the audit exists. Net findings:

- 9 of 11 high-signal bugs have direct semantic-match coverage (`evidence_strength: semantic`).
- 2 real test gaps (Grok `models_ok_chat_400`, #83 split-plan recommendation).
- Spec gaps dominate test gaps; documentation completion is the larger workstream.

No additional audit work; this layer is done. Layer 4 references it.

## 6. Coverage matrix — schema and gate

`tests/coverage-matrix.yml`:

```yaml
version: 2
plugins:
  - name: claude
    architecture: companion
    flows: [preflight, run, _run-worker, continue, ping, status, result, cancel]
    modes: [foreground, background]    # both apply
    cases: &companion_cases
      - happy_path
      - bad_args
      - auth_failure
      - missing_binary
      - provider_unavailable
      - malformed_provider_output
      - timeout
      - cancellation
      - scope_failed
      - source_not_sent_on_prelaunch_failure
      - lifecycle_event_emission
      - jobrecord_shape
      - secret_redaction_envstrip
      - packaged_copy_drift
  - name: gemini
    architecture: companion
    flows: [preflight, run, _run-worker, continue, ping, status, result, cancel]
    modes: [foreground, background]
    cases: *companion_cases
  - name: kimi
    architecture: companion
    flows: [preflight, run, _run-worker, continue, ping, status, result, cancel]
    modes: [foreground, background]
    cases:
      - <<: *companion_cases
      - step_limit_exceeded     # kimi-only
      - usage_limited            # kimi-only
      - sandbox_blocked          # kimi-only ping classification
  - name: grok
    architecture: grok
    flows: [doctor, run, result, list]    # NO status/cancel/background
    modes: [foreground]
    cases:
      - happy_path
      - bad_args
      - scope_failed
      - scope_empty
      - scope_base_invalid
      - scope_file_too_large
      - scope_total_too_large
      - unsafe_scope_path
      - git_failed
      - tunnel_timeout
      - tunnel_unavailable
      - tunnel_error
      - session_expired
      - usage_limited
      - malformed_response
      - grok_chat_timeout
      - grok_chat_model_rejected
      - models_ok_chat_400          # known #77 gap; UNFILLED
      - state_lock_timeout
      - malformed_record
      - not_found
      - lifecycle_event_emission
      - source_transmission_classification
      - secret_redaction_outputtime
  - name: api-reviewers-deepseek
    architecture: api-reviewers
    flows: [doctor, run]    # NO status/result/cancel/list
    modes: [foreground]
    cases: &api_reviewers_cases
      - happy_path
      - bad_args
      - config_error
      - missing_key
      - auth_rejected
      - rate_limited
      - provider_unavailable
      - malformed_response
      - mock_assertion_failed
      - scope_failed
      - timeout
      - lifecycle_event_emission
      - jobrecord_shape
      - source_transmission_classification
      - secret_redaction_outputtime    # echo-attack defense
      - locking_two_stage_gate
      - cross_host_owner_refusal
  - name: api-reviewers-glm
    architecture: api-reviewers
    flows: [doctor, run]
    modes: [foreground]
    cases: *api_reviewers_cases

architecture_invariants:
  # cells that apply to ALL plugins (the universal contracts)
  - name: source_content_transmission_mapping
    test: tests/property/source-transmission.property.test.mjs::sourceContentTransmissionForExecution exhaustive
  - name: external_review_keys_aligned
    test: tests/unit/job-record.test.mjs::external_review sub-fields have a canonical list

coverage:
  # Each cell has exactly one of: test | uncoverable | unfilled_tracked
  # Tuple absent from coverage = bare UNFILLED → gate fails.
  # ... populated as part of v2 implementation
```

Gate (`scripts/ci/check-coverage-matrix.mjs`):

1. Parse YAML; schema-validate per-plugin shape.
2. For each plugin, enumerate `flows × modes × cases`.
3. For each tuple, require it appear in `coverage:` exactly once with exactly one of `test`, `uncoverable`, or `unfilled_tracked`.
4. `test:` cells: file must exist, test name grep-matchable.
5. `uncoverable:` cells: reason must reference issue `#NNN`.
6. `unfilled_tracked:` cells: must reference an OPEN issue (verified via local cache file `tests/regression-exemptions.yml`, NOT live `gh issue view` — Layer 2 finding M5 about network dependency).
7. Architecture invariants: each must reference a real test.
8. Print summary: `coverage: X/Y per-plugin tuples covered, W uncoverable, V tracked-unfilled, U bare-UNFILLED; A architecture invariants verified.`

Wire into `package.json` as `lint:coverage-matrix` and the CI `lint` job.

## 7. Regression-test coverage check (replaces v1 linker)

V1's "test must cite the issue #" rule would have caught 1 of 11 closed bugs (Layer 2 finding). Drop it. Replace with semantic-match:

`scripts/ci/check-regression-coverage.mjs`:

1. Read closed bug-labeled issues from `tests/regression-coverage-cache.yml` (refreshed by a separate scheduled job — NOT live `gh` per Layer 2 M5).
2. For each issue, extract failure-signature strings from issue body via a designated frontmatter key `regression_signatures: [...]`. Operator authors this when closing the issue.
3. For each signature, `grep -rl <signature> tests/` — require at least one match.
4. Allow opt-out via `tests/regression-coverage-exemptions.yml` with reason.
5. CI fails on missing match without exemption.

The signature list is operator-curated; it's the only way the rule is workable. The closing operator knows what string in test code would prove the bug is no longer regressible. v1's mechanical citation requirement abdicates this judgment.

Migration: at v2 land time, populate `regression_signatures` for the 11 high-signal closed issues using Layer 2's semantic-match strings (`argv0_mismatch`, `Max number of steps reached`, `scope_total_too_large`, etc.). Each takes ~30 seconds to extract; total bootstrap is ~10 minutes.

## 8. Property-based contract tests

Devdep: `fast-check` (~200kB, MIT, no transitive deps). First devDep added to repo — accept as a one-time supply-chain cost.

**Single primary property test, anchored on the universal contract:**

`tests/property/source-transmission.property.test.mjs`:

- Generator: arbitrary `(status, errorCode, pidInfo)` tuples drawn from the union of valid values across all three architecture status/error_code enums. Specifically:
  - `status` ∈ `{queued, running, completed, cancelled, failed, stale}` (companion superset).
  - `errorCode` ∈ `{null, scope_failed, spawn_failed, finalization_failed, timeout, parse_error, claude_error, gemini_error, kimi_error, step_limit_exceeded, usage_limited, stale_active_job, tunnel_timeout, tunnel_unavailable, tunnel_error, session_expired, malformed_response, grok_chat_timeout, grok_chat_model_rejected, state_lock_timeout, auth_rejected, rate_limited, provider_unavailable, missing_key, mock_assertion_failed, provider_error, config_error, models_ok_chat_400}` (union of all three).
  - `pidInfo` ∈ `{null, {pid: int, starttime: string, argv0: string}}`.
- Property: `sourceContentTransmissionForExecution(status, errorCode, pidInfo)` matches the table in `docs/contracts/external-review.md` exactly. Run ≥1000 cases.
- This is THE security-critical invariant — answers "did source bytes leave the workstation."

**Three secondary property tests:**

`tests/property/jobrecord-shape.property.test.mjs`:
- Generator: arbitrary JobRecord-shaped objects per claude/gemini/kimi schema.
- Property 1: every JobRecord round-trips losslessly through `JSON.stringify` → `JSON.parse`.
- Property 2: `EXPECTED_KEYS` set of every constructed JobRecord matches per the canonical export.

`tests/property/external-review-keys.property.test.mjs`:
- Generator: arbitrary inputs to `buildExternalReview`.
- Property: produced object's key set === `EXTERNAL_REVIEW_KEYS` exactly, in the same order.

`tests/property/redaction.property.test.mjs`:
- Three sub-properties, one per mechanism:
  - **Companion**: `sanitizeTargetEnv(env, options)` produces an output env where no key in the policy matches; for any random secret-suffixed env key with random value, the output omits it.
  - **api-reviewers**: for any random secret-shaped string injected into a request body and then echoed back in a response, `redactValue(record)` produces output whose `result` does not contain the literal secret. Tests both 4-char (configured) and 8-char (auto-detected) thresholds.
  - **grok**: for any env value matching `/(?:API_KEY|TOKEN|COOKIE|SESSION|SSO)/i` ≥ 8 chars, `redactValue(record, redactor(env))` produces output where the value is replaced.

Each property runs ≥1000 cases per CI run; failing case is shrunk and printed.

## 9. Chaos harness

`tests/chaos/harness.mjs` — in-process fault injection helpers.

Three named scenarios, each mapped to a closed bug. Layer 2 confirmed these are the ones in-process fault injection actually catches:

- `tests/chaos/kill-mid-stream.chaos.test.mjs` — kills child after first stdout chunk (signal-driven, NOT timer-driven, per v1 internal review M2). Asserts JobRecord ends `cancelled` if pre-spawn child trap is configured, otherwise `failed` with `error_code === "claude_error"` (or per-plugin variant). Maps to non-approval-failure surface (#77 verifies failure-shape, not log content).
- `tests/chaos/malformed-json.chaos.test.mjs` — provider mock returns truncated JSON mid-array, asserts JobRecord ends `failed` with `error_code === "parse_error"`. Maps to #52 (Kimi non-JSON parse_error).
- `tests/chaos/oversized-scope.chaos.test.mjs` — scope diff exceeds budget, asserts prelaunch denial fires before any provider call, no source bytes sent. Maps to #83 (oversized branch-diff). v2 also verifies the new behavior added by #95: error_message includes a deterministic file-size manifest sorted by largest contributors (this closes the #83 spec_gap surfaced in Layer 2).

Plus **2 named regression tests** for the genuine gaps Layer 2 surfaced (these are NOT chaos tests, they're targeted unit/smoke):

- `tests/smoke/grok-web.smoke.test.mjs::doctor classifies models_ok_chat_400 when /models returns 200 but /chat/completions returns 400 with non-rejection body` — closes #77 gap that no doctor smoke constructs the two-stage probe scenario.
- `tests/smoke/grok-web.smoke.test.mjs::scope_total_too_large includes file-size manifest in error_message` — closes #83 gap that the recommendation/manifest behavior isn't asserted.

## 10. Flake gate (per-PR + nightly, not just nightly)

V1 proposed nightly-only. Layer 2's #25 explicitly asked for "50/50 runs on Linux" and #30 asked for "5 times in a row" — neither was satisfied by nightly. Statistical analysis: 20× nightly catches 5%-flake at ~95% across 3 nights, but 1%-flake takes ~5 weeks. Per-PR detection is the higher-leverage lever for new flakes attributable to authors.

`scripts/ci/run-tests-repeat.mjs` (unchanged from v1).

`.github/workflows/flake-pr.yml`:
- Triggers on PR open / sync, only when files under `tests/smoke/` or `plugins/*/scripts/` are changed.
- Identifies the smoke target(s) most likely to be affected by changed files.
- Reruns those smoke targets 5× serially.
- Fails on any non-deterministic outcome.

`.github/workflows/flake-nightly.yml`:
- `cron: '0 7 * * *'` (07:00 UTC, off-peak ubuntu-latest).
- Matrix over the 5 smoke targets.
- 20× repetition each.
- Reports name + run number on flake.

## 11. Fixture provenance

(Largely unchanged from v1, with Layer 3 corrections.)

`tests/smoke/fixtures/<plugin>/<scenario>.{response,provenance}.json`. Schema for `provenance.json`:

```json
{
  "model_id": "<plugin-specific>",
  "recorded_at": "<ISO 8601>",
  "prompt_hash": "sha256:...",
  "sanitization_notes": "redacted: api_key, oauth_token, user.email",
  "recorded_by": "manual: workflow_dispatch run #N",
  "stale_after": "<ISO 8601, default 90 days from recorded_at>"
}
```

Freshness gate (`scripts/ci/check-fixture-freshness.mjs`): warns when `stale_after` is in the past. **Escalation tightening from v1**: failure escalation is added in v2 because v1's deferral is what the methodology hedge specifically attacked. Concretely: warn when ≤30 days from `stale_after`; fail when past `stale_after` + 30-day grace period. Rationale: a fixture nobody refreshes is no fixture.

`scripts/smoke-rerecord.mjs` + `.github/workflows/smoke-rerecord.yml` — `workflow_dispatch` only, gated by per-plugin secrets, sanitizes responses, opens a PR with diff. **Today: stub workflow + sanitization library; no actual recording until per-plugin secrets are added.** This is the only piece that materially defers in v2 vs v1; it requires user-side work (adding repo secrets) that is not in this spec's scope to prescribe.

## 12. Honesty banner

```
================================================================
SMOKE PROVES:
  - Local CLI entrypoint spawns and exits with expected code
  - Fixture-replay or hand-mock provider response is consumed correctly
  - JobRecord shape and external_review key alignment hold
  - source_content_transmission classification matches the canonical mapping
  - Redaction surface for this architecture is intact
  - No non-deterministic outcomes across 5× rerun on changed targets

SMOKE DOES NOT PROVE:
  - Live provider auth (no real OAuth this run) [tracked: #<phase-2-issue>]
  - Real model output correctness (response is from fixture or hand-mock) [tracked: #<phase-2-issue>]
  - Fixture freshness beyond <stale_after> (last recorded <recorded_at>)
  - OS/Node coverage outside ubuntu-latest + Node 20 [tracked: #<phase-2-issue>]
================================================================
```

**Enforcement**: every "DOES NOT PROVE" line MUST reference an open follow-up issue. `scripts/ci/check-honesty-banner.mjs` parses the banner template and verifies referenced issues are open. If an issue closes, the line must be removed (or the gap must in fact still exist and the line moved to a new tracking issue).

## 13. `docs/contracts/` completion sweep

Layer 2 found that spec gaps dominate test gaps. Most invariants are tested but undocumented in `docs/contracts/`. v2 commits to closing the gap.

Items to document (each is a small section addition or new file):

| Item | Add to | Why |
|---|---|---|
| `argv0_mismatch` capture-after-`'spawn'` invariant (#25 gap) | new `docs/contracts/pid-info-capture.md` | Behavioral contract for dispatcher implementation; prevents future regressions in the argv0 detection path. |
| Setup-check command shape (`status`, `ready`, `summary`, `detail`) (#20 gap) | new `docs/contracts/doctor-output.md` (covers both companion `cmdPing` and grok/api-reviewers `cmdDoctor`) | First-run UX path has shape that's tested but not documented. |
| Preflight contract (`target_spawned`, `selected_scope_sent_to_provider`, `requires_external_provider_consent`) (#27 gap) | extend `redaction.md` or add `preflight.md` | Critical safety fields. Source: `companion-common.mjs:197-203`. |
| Test-helper invariants (`GIT_DIR`/`GIT_WORK_TREE` isolation, `-b main`) (#30 gap) | new `tests/helpers/README.md` | Tribal knowledge that broke in #30; documenting prevents repeat. |
| Per-plugin timeout-default + env-var asymmetry (#41/#86 gap) | new `docs/contracts/env-vars.md` | `CLAUDE_REVIEW_TIMEOUT_MS` / `GEMINI_REVIEW_TIMEOUT_MS` / `KIMI_REVIEW_TIMEOUT_MS` / `GROK_WEB_TIMEOUT_MS` / `API_REVIEWERS_TIMEOUT_MS` are inconsistent in naming and default. |
| Sync invariant for installed-plugin layout (#49 gap) | extend `redaction.md` or new `sync-surface.md` | "Installed plugin must be self-contained" is implicit in `lint:sync` + `tests/unit/plugin-copies-in-sync.test.mjs`. |
| Codex-sandbox interaction matrix (`network_access`, `writable_roots` per provider) (#56 gap) | new `docs/contracts/sandbox-interactions.md` | OSS users need explicit guidance, not "disable sandbox." |
| Doctor-output contract per plugin (especially grok 2-stage probe) (#77 gap) | extend `grok-output.md` and add doctor-output sections | Models-ok-chat-400 classification belongs here. |
| Per-provider scope budget table (#83 gap) | new `docs/contracts/scope-budgets.md` | Grok 1MiB hard cap, api-reviewers preflight estimate, companion no cap. |

Gate: `scripts/ci/check-contracts-doc-coverage.mjs` — parses every exported field/enum value from `EXPECTED_KEYS`, `EXTERNAL_REVIEW_KEYS`, `SOURCE_CONTENT_TRANSMISSION`, `error_code` enum, `GROK_EXPECTED_KEYS`, `api-reviewers` extras (`auth_mode`/`endpoint`/`http_status`/`raw_model`); requires each to be mentioned in `docs/contracts/` somewhere. Fails on missing.

## 14. Acceptance criteria

The branch is mergeable when all of the following are true:

1. `tests/coverage-matrix.yml` exists with the per-plugin shape from §6. `npm run lint:coverage-matrix` passes. No bare UNFILLED tuples.
2. `tests/regression-coverage-cache.yml` and `tests/regression-coverage-exemptions.yml` exist. `regression_signatures` populated for the 11 high-signal closed issues. `npm run lint:regression-coverage` passes.
3. `tests/property/source-transmission.property.test.mjs` exists, runs ≥1000 cases against the union enum, all pass.
4. `tests/property/{jobrecord-shape, external-review-keys, redaction}.property.test.mjs` exist, each runs ≥1000 cases, all pass.
5. `tests/chaos/{kill-mid-stream, malformed-json, oversized-scope}.chaos.test.mjs` exist, each cites the mapped closed bug, all pass.
6. **2 named regression tests for genuine gaps:** `tests/smoke/grok-web.smoke.test.mjs::doctor classifies models_ok_chat_400 ...` and `... scope_total_too_large includes file-size manifest`. Both pass.
7. `.github/workflows/flake-pr.yml` and `.github/workflows/flake-nightly.yml` exist with the configurations from §10.
8. Fixture provenance schema documented; sanitization library and rerecord stub workflow exist; no actual recording.
9. Every smoke job emits the honesty banner; `scripts/ci/check-honesty-banner.mjs` validates referenced follow-up issues are open.
10. `docs/contracts/` completion sweep done — all 9 items in §13 added. `npm run lint:contracts-doc-coverage` passes.
11. Existing `npm test`, `npm run test:full`, `npm run lint`, `npm run lint:sync` all pass.
12. The follow-up consolidated issue is filed listing every deferred item with concrete numbered sub-bullets.

## 15. Non-goals

- Spending real model quota in ordinary PR CI.
- Live OAuth/browser/provider sessions in every PR.
- Replacing external latest-head review gates where required by process.
- Rewriting the existing smoke suite's assertions in bulk (Layer 2 confirmed coverage is broad already).
- Validating real-model output correctness on every PR.

## 16. Risks

- **Property-test enum drift.** When a new error_code is added to any architecture, the union enum in §8 must be updated or the property test gets stale. Mitigation: a unit test asserts the property-test enum equals the union of `error_code` values exported from the canonical libs.
- **Regression-signature curation burden.** §7 requires the issue-closer to think about what string in test code proves the bug is gone. If signatures aren't curated thoughtfully, the gate becomes ceremony. Mitigation: the consolidated follow-up issue includes a "regression-signatures" template; PR template prompts for signature when closing a bug-labeled issue.
- **Per-PR flake gate runtime cost.** 5× rerun on changed smoke targets adds ~5× the smoke time on every PR. Mitigation: only triggers when `tests/smoke/` or `plugins/*/scripts/` change; doc-only PRs are unaffected.
- **Fixture-recording remains deferred.** This is the one piece that requires user-side work (repo secrets) that's outside this spec's scope. v2 surfaces this as the loudest risk in the honesty banner so it cannot be forgotten. Phase 2 has a concrete plan for first re-record cycle.
- **`docs/contracts/` completion sweep is large** (9 items). If it's not done atomically, the build-failing gate (`check-contracts-doc-coverage.mjs`) blocks any other change. Mitigation: land the completion sweep in this same PR as the gate, OR ship the gate in WARN mode for one merge cycle and flip to FAIL after sweep is complete.

## 17. Open questions for the adversarial panel

These are the specific decisions most likely to be wrong. Reviewers should attack them directly:

1. **Strategy choice (B refined).** Layer 2 confirmed B is right. But: is the *refined* B (universal-contract anchor for property tests + per-plugin matrix + semantic-match linker) actually better than (a) much simpler "just close the 2 gaps and document the contracts," or (b) much more ambitious "Strategy C with mutation testing on top"?

2. **Anchoring property tests on `sourceContentTransmissionForExecution`.** This is *the* security-critical invariant. But it's already exhaustively tested as example-tests in `tests/unit/job-record.test.mjs`. Does property-fuzzing add detectable value, or is it ceremony on top of already-thorough example coverage?

3. **Regression-signature curation requirement.** §7's rule only works if the issue-closer authors `regression_signatures: [...]`. Is this realistic, or is it a process change that won't happen and the gate becomes vacuous?

4. **Per-PR 5× flake rerun on changed smoke targets.** Is 5× enough to catch new flakes attributable to the author? Or is it theatrical and the real value is nightly 20×? Cost-vs-detection.

5. **`docs/contracts/` completion sweep landing atomically.** §13 has 9 items. Is "all 9 in one PR" realistic, or should it be phased? If phased, what's the gate's failure-mode during the transition?

6. **Honesty-banner enforcement that "DOES NOT PROVE" lines reference open issues.** Cute or load-bearing? If a line references an issue that closes, the gate forces removing the line — but what if the gap is real and we just couldn't find a tracking issue?

7. **2 named regression tests for the gaps Layer 2 surfaced.** Sufficient? Or does "spec_gap dominates test_gap" mean we need *fewer* tests and more docs? Layer 2 thinks yes; reviewers should attack this.

8. **`stale_after` 30-day grace before fail-escalation.** v1 was warn-only; v2 fails after grace. Is 30 days too aggressive (operators will be paged before they can re-record) or too lenient (drift accumulates undetected)?

9. **Architecture-invariant cells in the matrix.** §6 has a small `architecture_invariants` block for cells that apply to ALL plugins (the universal contracts). Is that the right structure, or should it be a separate doc/file?

10. **The deferred fixture-recording.** Same as v1 Q2. v2 makes it louder via banner enforcement, but the underlying gap is unchanged. Is that an acceptable cut, or does v2 still hand-wave the central #103 concern?

11. **Acceptance criterion for "every JobRecord field documented".** §13's `check-contracts-doc-coverage.mjs` enforces this. Is mention-anywhere-in-docs/contracts/ a sufficient check, or does each field need a dedicated paragraph (more rigorous, more maintenance)?
