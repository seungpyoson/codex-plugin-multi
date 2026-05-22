# Session Readiness - 2026-05-22

Scope: source-free readiness only. No selected source was sent by any command in this artifact.

## Claude Source-Free Doctor

Command:

```sh
node plugins/claude/scripts/claude-companion.mjs doctor --auth-mode subscription --cwd /Users/spson/Projects/Claude/codex-plugin-multi
```

Observed at `2026-05-22 05:19:01 KST`.

Result:

- `ready:false`
- `status:"error"`
- `source_content_transmission:"not_sent"` by doctor design; no selected source was provided to the command.
- `selected_auth_path:"subscription_oauth"`
- `selected_route:"subscription_oauth"`
- `fallback_reason:null`
- `ignored_env_credentials:["ANTHROPIC_API_KEY"]`
- `auth_policy:"api_key_env_ignored"`
- `source_send_approval_required:false`
- `source_send_approval_state:"not_required"`
- `detail:"You've hit your session limit · resets 6:10am (Asia/Seoul)"`

Interpretation: current Claude readiness is blocked by subscription session limit before any source send. This supersedes older same-session ready notes until a fresh source-free doctor succeeds.

## Claude Source-Free Follow-Up

Same command, no selected source provided.

- `2026-05-22 06:11 KST`: `ready:true`, `status:"ok"`, `selected_route:"subscription_oauth"`, `source_send_approval_state:"not_required"`, ignored `ANTHROPIC_API_KEY`, model `claude-opus-4-7`.
- T078 source-bearing Claude C2 then sent the approved 5-file source packet and completed as job `98c59d7b-60fe-4cc9-ad09-cbb67fff2ea1` with `review_quality.failed_review_slot:false`.
- `2026-05-22 06:23 KST`: immediate fresh pre-send doctor for the next Claude source-bearing packet returned `status:"oauth_inference_rejected"`, `ready:false`, `selected_route:"subscription_oauth"`, `fallback_reason:null`, ignored `ANTHROPIC_API_KEY`, `auth_policy:"api_key_env_ignored"`, `source_send_approval_required:false`, `source_send_approval_state:"not_required"`, OAuth `logged_in:true`, `auth_method:"claude.ai"`, `api_provider:"firstParty"`, `subscription_type:"max"`, and `detail:"Failed to authenticate. API Error: 401 Invalid authentication credentials"`.
- `2026-05-22 06:27 KST`: source-free T080 pre-check returned the same `status:"oauth_inference_rejected"`, `ready:false`, `selected_route:"subscription_oauth"`, `fallback_reason:null`, ignored `ANTHROPIC_API_KEY`, `auth_policy:"api_key_env_ignored"`, `source_send_approval_required:false`, `source_send_approval_state:"not_required"`, OAuth `logged_in:true`, `auth_method:"claude.ai"`, `api_provider:"firstParty"`, `subscription_type:"max"`, and `detail:"Failed to authenticate. API Error: 401 Invalid authentication credentials"`.
- `2026-05-22 06:46 KST`: source-free recheck returned the same `status:"oauth_inference_rejected"`, `ready:false`, `selected_route:"subscription_oauth"`, `fallback_reason:null`, ignored `ANTHROPIC_API_KEY`, `auth_policy:"api_key_env_ignored"`, `source_send_approval_required:false`, `source_send_approval_state:"not_required"`, OAuth `logged_in:true`, `auth_method:"claude.ai"`, `api_provider:"firstParty"`, `subscription_type:"max"`, and `detail:"Failed to authenticate. API Error: 401 Invalid authentication credentials"`.
- No source was sent by any source-free doctor in this section.

Interpretation: Claude readiness is route-correct and non-API-fallback, but current live readiness can still flip from ready to OAuth 401 before the next source send. Latest proof is OAuth non-interactive inference rejection, not session-limit text. Every source-bearing Claude run still needs immediate source-free proof.

## Claude API-Key Source-Free Probe

Command:

```sh
node plugins/claude/scripts/claude-companion.mjs doctor --auth-mode api_key --cwd /Users/spson/Projects/Claude/codex-plugin-multi
```

Observed at `2026-05-22 06:27 KST`.

Result:

- `ready:true`
- `status:"ok"`
- `auth_mode:"api_key"`
- `selected_auth_path:"api_key_env"`
- `selected_route:"direct_api"`
- `fallback_reason:"explicit_api"`
- `allowed_env_credentials:["ANTHROPIC_API_KEY"]`
- `auth_policy:"api_key_env_allowed"`
- `source_send_approval_required:false`
- `source_send_approval_state:"not_required"`
- `model:"claude-opus-4-7"`
- `source_content_transmission:"not_sent"` by doctor design; no selected source was provided to the command.

Interpretation: Claude API-key auth is still available when explicitly selected. This is not fallback from subscription mode. Source-bearing `api_key` runs remain stopped by the source-send approval gate unless explicit route/source approval is present.

## Claude Explicit API Source-Send Approval Gate

Observed at `2026-05-22 06:45 KST`.

Local RED/GREEN proof:

- RED: `node --test --test-name-pattern "approval-request: explicit api_key" tests/smoke/claude-companion.smoke.test.mjs` initially failed because `claude-companion.mjs` had no `approval-request` subcommand for Claude explicit API source-bearing runs.
- GREEN: `approval-request` now emits `source_content_transmission:"not_sent"`, `selected_route:"direct_api"`, `fallback_reason:"explicit_api"`, `approval_scope:"session"`, and `approval_token.value` before any Claude launch.
- Matching `run --approval-token <approval_token.value>` unlocks the same source packet and records `source_content_transmission:"sent"` plus `source_send_approval_state:"approved"` in the terminal audit manifest.
- Unapproved explicit `api_key` source-bearing `run` still fails before Claude spawn with `error_code:"approval_required"` and `source_content_transmission:"not_sent"`.
- Normal subscription source-bearing runs keep `approval_scope:null`, `source_send_approval_required:false`, and `source_send_approval_state:"not_required"`.

Verification:

- `node --test --test-name-pattern "review docs expose custom-review" tests/unit/docs-contracts.test.mjs` passed 1/1.
- `node --test --test-name-pattern "run --mode=review --foreground: emits JobRecord" tests/smoke/claude-companion.smoke.test.mjs` passed 1/1.
- `node --test --test-name-pattern "explicit api_key source-bearing review requires approval|approval-request: explicit api_key|subscription auth does not source-send through API fallback" tests/smoke/claude-companion.smoke.test.mjs` passed 3/3.
- `node --test tests/unit/auth-selection.test.mjs tests/unit/provider-route-policy.test.mjs` passed 7/7.
- `node --test tests/unit/docs-contracts.test.mjs` passed 33/33.
- `npm run smoke:claude` passed 118/118.
- `npm run lint:sync` passed.
- `git diff --check` passed.

Interpretation: Claude API is available only through explicit route selection and source-send approval. Subscription mode still ignores API keys and never silently falls back for source-bearing packets.

## Claude Approval Runtime A2 Adjudication

Observed at `2026-05-22 11:30 KST`.

Gemini A2 `REQUEST_CHANGES` was partially valid:

- Real: background `runtime-options.json` could survive source-free failure paths that stop before the worker reads runtime options. Proven RED failures:
  - `node --test --test-name-pattern "_run-worker: cancel marker prevents target spawn, sets status=cancelled" tests/smoke/claude-companion.smoke.test.mjs` failed because queued cancel removed `prompt.txt` but left `runtime-options.json`.
  - `node --test --test-name-pattern "run --background: worker spawn failure writes failed JobRecord instead of launched" tests/smoke/claude-companion.smoke.test.mjs` failed because launcher-side worker spawn failure removed `prompt.txt` but left `runtime-options.json`.
  - `node --test --test-name-pattern "_run-worker removes runtime-options sidecar when prompt sidecar is missing" tests/smoke/claude-companion.smoke.test.mjs` failed because prompt-missing worker failure happened before runtime-options consumption.
- GREEN: Claude now consumes/deletes `runtime-options.json` on queued cancel, worker spawn failure, prompt-sidecar consume failure, and prompt-sidecar missing failure before writing terminal records.
- Not reproduced: approval token persistence in JobRecords. The background explicit API approval test now asserts the terminal JobRecord and audit manifest have no `approval_token` property and do not contain `approval_token.value`; focused proof passed.

Verification:

- `node --test --test-name-pattern "run --background: worker spawn failure writes failed JobRecord instead of launched|_run-worker: cancel marker prevents target spawn, sets status=cancelled|_run-worker removes runtime-options sidecar when prompt sidecar is missing|approval-request: explicit api_key background review token reaches worker" tests/smoke/claude-companion.smoke.test.mjs` passed 4/4.
- `npm run smoke:claude` passed 120/120.

Interpretation: the A2 sidecar cleanup blocker is fixed locally. The JobRecord token-leak claim is disproven by current test evidence. T079 still needs fresh Claude subscription ready proof before remaining source-bearing Claude review, or an accepted T082-format waiver.

## Claude Approval Runtime A3 Review And B1 Fix

Observed at `2026-05-22 11:48 KST`.

Source-free pre-send proof:

- `node plugins/claude/scripts/claude-companion.mjs doctor --auth-mode subscription --cwd /Users/spson/Projects/Claude/codex-plugin-multi` returned `status:"ok"`, `ready:true`, `selected_route:"subscription_oauth"`, `fallback_reason:null`, `source_send_approval_state:"not_required"`, ignored `ANTHROPIC_API_KEY`, model `claude-opus-4-7`, and session `a6681887-2d40-4399-9352-bb93632d5d41`. No selected source was provided.

A3 review scope was 5 files / 487147 bytes / 8601 lines:

- `plugins/claude/scripts/claude-companion.mjs`
- `tests/smoke/claude-companion.smoke.test.mjs`
- `specs/140-no-mistakes-provider-readiness/session-readiness-2026-05-22.md`
- `specs/140-no-mistakes-provider-readiness/tasks.md`
- `specs/140-no-mistakes-provider-readiness/completion-audit-manifest-2026-05-21.json`

Pre-send direct API approval proof:

- DeepSeek approval-request returned `source_content_transmission:"not_sent"`, selected source 5 files / 487147 bytes / 8601 lines, `selected_route:"direct_api"`, `fallback_reason:"subscription_not_supported"`, `approval_scope:"session"`, and token `73de9f7d6dd53bfce99d057cf612cfd8d20fd1e37d6edc33e18da1e34fd63070`.
- GLM approval-request returned `source_content_transmission:"not_sent"`, selected source 5 files / 487147 bytes / 8601 lines, `selected_route:"direct_api"`, `fallback_reason:"subscription_not_supported"`, `approval_scope:"session"`, and token `21c4ac5c5ffb77424b7495466611f507a96b7e3ecb4536b43632071eb9ab954f`.

A3 source-bearing review results:

- Claude `725f90cf-16d7-4dce-9e32-232f14a39622`: source sent through `subscription_oauth`, `review_quality.failed_review_slot:false`, `Verdict: REQUEST_CHANGES`.
- Gemini `b2d198c7-4836-446a-9a2c-588162e2ed42`: source sent through `subscription_oauth`, `review_quality.failed_review_slot:false`, `Verdict: REQUEST_CHANGES`.
- Kimi `11fc5e7a-0b77-4b8b-bd70-8f873989dcf5`: source sent through `subscription_oauth`, `review_quality.failed_review_slot:false`, `Verdict: REQUEST_CHANGES`.
- DeepSeek `job_47ca08f9-fd42-4a6d-8df3-c50eb0799cde`: source sent through direct API with approved token, `review_quality.failed_review_slot:false`, `Verdict: APPROVE`.
- GLM `job_48f5dac1-8b83-49c4-b293-b90492696968`: source sent through direct API with approved token, `review_quality.failed_review_slot:false`, `Verdict: APPROVE`.
- Grok full packet `job_fec04d32-09f8-435a-aa85-d4ebe4ff2539`: failed before source as `prompt_too_large:490981 chars exceeds GROK_WEB_MAX_PROMPT_CHARS=400000`, `source_content_transmission:"not_sent"`.
- Grok shard A `job_fd8a8141-d40f-4720-a763-d1bdbe0eaf3f`: source sent through `subscription_web`, `review_quality.failed_review_slot:false`, `Verdict: APPROVE`.
- Grok shard B `job_aec24ac4-61dd-428f-a8cb-63cc3c41094a`: source sent through `subscription_web`, `review_quality.failed_review_slot:false`, `Verdict: APPROVE`.

Claude, Gemini, and Kimi found the same real blocker: if background `writePromptSidecar()` succeeded and `writeRuntimeOptionsSidecar()` then failed before worker launch, `failBackgroundPromptSidecarWrite()` wrote a terminal failed record without deleting the source-bearing `prompt.txt`.

RED/GREEN fix:

- RED: `node --test --test-name-pattern "run --background: runtime-options write failure removes prompt sidecar" tests/smoke/claude-companion.smoke.test.mjs` failed because `prompt.txt` persisted after injected `runtime-options.json` rename failure.
- GREEN: `failBackgroundPromptSidecarWrite()` now best-effort consumes both `prompt.txt` and `runtime-options.json` before writing the terminal failed JobRecord.

Verification:

- Focused T079 cleanup/approval group passed 5/5:
  - `run --background: runtime-options write failure removes prompt sidecar`
  - `run --background: worker spawn failure writes failed JobRecord instead of launched`
  - `_run-worker: cancel marker prevents target spawn, sets status=cancelled`
  - `_run-worker removes runtime-options sidecar when prompt sidecar is missing`
  - `approval-request: explicit api_key background review token reaches worker`
- `npm run smoke:claude` passed 121/121.

Interpretation: A3's launcher-side prompt-sidecar blocker is fixed locally.

## T079 A4/A6 Post-Fix Review Closure

A4 immediate source-free Claude pre-send proof:

- `node plugins/claude/scripts/claude-companion.mjs doctor --auth-mode subscription --lifecycle-events jsonl` returned `status:"ok"`, `ready:true`, `selected_route:"subscription_oauth"`, `fallback_reason:null`, `source_send_approval_state:"not_required"`, ignored `ANTHROPIC_API_KEY`, model `claude-opus-4-7`, and session `cc2ae243-cb06-4714-8c7d-49f7425f86cf`. No selected source was provided.

A4 post-fix review scope was 6 files / 496263 bytes / 8712 lines:

- `plugins/claude/scripts/claude-companion.mjs`
- `tests/smoke/claude-companion.smoke.test.mjs`
- `tests/helpers/fail-runtime-options-rename.mjs`
- `specs/140-no-mistakes-provider-readiness/session-readiness-2026-05-22.md`
- `specs/140-no-mistakes-provider-readiness/tasks.md`
- `specs/140-no-mistakes-provider-readiness/completion-audit-manifest-2026-05-21.json`

A4 direct API pre-send approval proof:

- DeepSeek approval-request returned `source_content_transmission:"not_sent"`, selected source 6 files / 496263 bytes / 8712 lines, `selected_route:"direct_api"`, `fallback_reason:"subscription_not_supported"`, and `approval_scope:"session"` before source send.
- GLM approval-request returned `source_content_transmission:"not_sent"`, selected source 6 files / 496263 bytes / 8712 lines, `selected_route:"direct_api"`, `fallback_reason:"subscription_not_supported"`, and `approval_scope:"session"` before source send.

A4 source-bearing review results:

- Claude `abe60982-7ff2-445d-bb91-e393120747e3`: source sent and raw result started `Verdict: APPROVE`, but persisted audit set `review_quality.failed_review_slot:true` with `semantic_failure_reasons:["permission_blocked"]`; this slot is not counted.
- Claude retry `523e784c-1ce5-429f-a4f9-271de5ed00a2`: source sent through `subscription_oauth`, `review_quality.failed_review_slot:false`, `Verdict: APPROVE`, and `runtime_diagnostics.permission_denials:[]`.
- Gemini `73b1039e-1cbd-48b0-8471-5d7a55a8f6d8`: source sent through `subscription_oauth`, `review_quality.failed_review_slot:false`, `Verdict: APPROVE`.
- Kimi `c3138aac-05f1-41c8-be3f-71c8a9daa2c6`: source sent through `subscription_oauth`, `review_quality.failed_review_slot:false`, `Verdict: APPROVE`.
- DeepSeek `job_dbbaf04b-9649-4bc3-a2f9-6003566b7bdc`: source sent through direct API with approved token, `review_quality.failed_review_slot:false`, `Verdict: APPROVE`.
- GLM `job_2f9075ad-b975-426b-9942-2365c41b42cc`: source sent through direct API with approved token, `review_quality.failed_review_slot:false`, `Verdict: APPROVE`.
- Grok shard A `job_a3ec1700-eee1-4a10-a06f-715611dcbed2`: source sent through `subscription_web`, `review_quality.failed_review_slot:false`, `Verdict: APPROVE`.
- Grok shard B `job_cd44177c-7da6-4cb3-a13d-9911908e414c`: source sent through `subscription_web`, `review_quality.failed_review_slot:false`, `Verdict: APPROVE`.

The uncounted Claude A4 slot exposed a review-quality classifier false positive: benign reviewer prose describing the injected `EACCES` cleanup test was treated as a real permission block. RED tests reproduced this across shared and packaged review-prompt modules; GREEN suppresses injected permission-test proof prose only when no concrete permission action phrase is present and keeps real read-denial cases failing closed.

A5/A6 classifier hardening:

- A5 found a second false positive where guardrail prose such as `EACCES on sample.js` plus `test assertion confirms permission_blocked` was treated as a real permission block.
- RED `review audit manifest does not flag permission guardrail test-assertion prose as permission blocked` failed across shared and packaged review-prompt modules.
- GREEN expanded the mechanics-discussion guard with `test assertion`, `test asserts`, `test confirms`, `line is flagged`, and `is flagged`, while focused real-denial tests still passed.

A6 review-quality classifier review scope was 7 files / 335431 bytes / 9316 lines:

- `scripts/lib/review-prompt.mjs`
- `plugins/api-reviewers/scripts/lib/review-prompt.mjs`
- `plugins/claude/scripts/lib/review-prompt.mjs`
- `plugins/gemini/scripts/lib/review-prompt.mjs`
- `plugins/grok/scripts/lib/review-prompt.mjs`
- `plugins/kimi/scripts/lib/review-prompt.mjs`
- `tests/unit/review-prompt.test.mjs`

A6 source-bearing review results:

- Claude `7c9eee50-147b-4d5f-baf6-ea6bfff170b9`: source sent through `subscription_oauth`, `review_quality.failed_review_slot:false`, `Verdict: APPROVE`, and `runtime_diagnostics.permission_denials:[]`.
- Gemini `3a1aef45-cd98-44c8-8d48-cb861e407c3f`: source sent through `subscription_oauth`, `review_quality.failed_review_slot:false`, `Verdict: APPROVE`.
- Kimi `e6080d31-0543-4cc3-bde2-17b541b5e5c6`: source sent through `subscription_oauth`, `review_quality.failed_review_slot:false`, `Verdict: APPROVE`.
- DeepSeek `job_fcf1055d-2be6-4e6c-aa88-e82b7faa88b5`: source sent through direct API with approved token, `review_quality.failed_review_slot:false`, `Verdict: APPROVE`.
- GLM `job_4457ac2a-b5a0-48ef-a69a-4e6cf0603646`: source sent through direct API with approved token, `review_quality.failed_review_slot:false`, `Verdict: APPROVE`.
- Grok Web `job_9896666d-0413-4291-bb9f-6eb56655a4b2`: source sent through `subscription_web`, `review_quality.failed_review_slot:false`, `Verdict: APPROVE`.

T079 closure verification:

- RED docs-contract update: `node --test --test-name-pattern "T084 completion audit manifest" tests/unit/docs-contracts.test.mjs` failed while S12 was still `status:"classified"`.
- GREEN docs-contract update: the same focused test passed after S12 moved to `status:"done"` with A4/A6 job evidence and no residual gates.
- `node --test tests/unit/review-prompt.test.mjs` passed 226/226.
- `npm run smoke:claude` passed 121/121.
- `node --test tests/unit/docs-contracts.test.mjs` passed 33/33.
- `npm run lint:sync` passed.
- `git diff --check` passed.

Interpretation: T079's Claude OAuth/API route decision is closed by live source-free proof plus source-bearing review. Claude API is still available only as explicit `api_key` route with approval gate; subscription mode does not silently fall back to API key. Runtime-options cleanup blockers are fixed. Classifier false positives found during review are fixed with RED/GREEN tests and all-provider A6 approval.

## Source-Free Provider Matrix

Observed at `2026-05-22 05:29:19 KST`.

| Provider | Command | Result | Route/auth facts | Source |
| --- | --- | --- | --- | --- |
| Gemini | `node plugins/gemini/scripts/gemini-companion.mjs doctor` | `ready:true` | `selected_route:"subscription_oauth"`, `auth_policy:"api_key_env_ignored"`, ignored `GEMINI_API_KEY`, model `gemini-3.1-pro-preview` | not sent |
| Kimi | `node plugins/kimi/scripts/kimi-companion.mjs doctor` | `ready:true` | `selected_route:"subscription_oauth"`, `auth_policy:"api_key_env_ignored"`, ignored `KIMI_CODE_API_KEY` and `MOONSHOT_API_KEY`, model `kimi-code/kimi-for-coding` | not sent |
| Grok CLI | `node plugins/grok/scripts/grok-web-reviewer.mjs doctor` | `ready:false` | `transport:"cli"`, `auth_mode:"subscription_cli"`, `logged_in:false`, `model_ready:true`, `error_code:"grok_cli_login_required"`, ignored `XAI_API_KEY` | not sent |
| Grok web | `node plugins/grok/scripts/grok-web-reviewer.mjs doctor --transport web` | `ready:true` | `auth_mode:"subscription_web"`, endpoint `http://127.0.0.1:8000/v1`, chat probe HTTP `200`, model `grok-4.20-fast` | not sent |
| DeepSeek | `node plugins/api-reviewers/scripts/api-reviewer.mjs doctor --provider deepseek` | `ready:true` | `credential_ref:"DEEPSEEK_API_KEY"`, HTTP `200`, model `deepseek-v4-pro` | not sent |
| GLM | `node plugins/api-reviewers/scripts/api-reviewer.mjs doctor --provider glm` | `ready:true` | `credential_ref:"ZAI_API_KEY"`, HTTP `200`, model `glm-5.1` | not sent |

## Current Source-Free Provider Matrix

Observed at `2026-05-22 06:46-06:48 KST`. No selected source was provided to any command.

| Provider | Command | Result | Route/auth facts | Source |
| --- | --- | --- | --- | --- |
| Claude | `node plugins/claude/scripts/claude-companion.mjs doctor --auth-mode subscription --cwd /Users/spson/Projects/Claude/codex-plugin-multi` | `ready:false`, `status:"oauth_inference_rejected"` | `selected_route:"subscription_oauth"`, `fallback_reason:null`, ignored `ANTHROPIC_API_KEY`, OAuth `logged_in:true`, `subscription_type:"max"`, detail `API Error: 401 Invalid authentication credentials` | not sent |
| Gemini | `node plugins/gemini/scripts/gemini-companion.mjs doctor` | `ready:true` | `selected_route:"subscription_oauth"`, ignored `GEMINI_API_KEY`, model `gemini-3.1-pro-preview` | not sent |
| Kimi | `node plugins/kimi/scripts/kimi-companion.mjs doctor` | `ready:true` | `selected_route:"subscription_oauth"`, ignored `KIMI_CODE_API_KEY` and `MOONSHOT_API_KEY`, model `kimi-code/kimi-for-coding` | not sent |
| Grok CLI | `node plugins/grok/scripts/grok-web-reviewer.mjs doctor` | `ready:false` | `auth_mode:"subscription_cli"`, `logged_in:false`, `model_ready:true`, `error_code:"grok_cli_login_required"`, ignored `XAI_API_KEY` | not sent |
| Grok web | `node plugins/grok/scripts/grok-web-reviewer.mjs doctor --transport web` | `ready:true` | `auth_mode:"subscription_web"`, endpoint `http://127.0.0.1:8000/v1`, chat probe HTTP `200`, model `grok-4.20-fast` | not sent |
| DeepSeek | `node plugins/api-reviewers/scripts/api-reviewer.mjs doctor --provider deepseek` | `ready:true` | `credential_ref:"DEEPSEEK_API_KEY"`, HTTP `200`, model `deepseek-v4-pro` | not sent |
| GLM | `node plugins/api-reviewers/scripts/api-reviewer.mjs doctor --provider glm` | `ready:true` | `credential_ref:"ZAI_API_KEY"`, HTTP `200`, model `glm-5.1` | not sent |

Interpretation:

- Gemini, Kimi, Grok web, DeepSeek, and GLM are source-free ready in this process.
- Grok CLI is not source-free ready because the CLI is logged out; direct API env vars remain ignored for subscription CLI mode.
- Claude is not source-free ready in the latest same-session proof; the earlier session-limit block was followed by OAuth non-interactive inference rejection after reset.

## T081 current Claude source-free blocker

Observed at `2026-05-22 13:29 KST`. No selected source was provided or sent.

Subscription route probe:

- Command: `node plugins/claude/scripts/claude-companion.mjs doctor --auth-mode subscription --cwd /Users/spson/Projects/Claude/codex-plugin-multi --timeout-ms 20000`
- Result: `ready:false`, `status:"error"`, `selected_route:"subscription_oauth"`, `fallback_reason:null`, `selected_auth_path:"subscription_oauth"`, `ignored_env_credentials:["ANTHROPIC_API_KEY"]`, `auth_policy:"api_key_env_ignored"`, `source_send_approval_state:"not_required"`, `exit_code:143`, and `detail:"target CLI exceeded the configured timeoutMs\nexit 143"`.
- Interpretation: subscription readiness is not clean enough for a T081 source-bearing Claude send.

Explicit API route probe:

- Command: `node plugins/claude/scripts/claude-companion.mjs doctor --auth-mode api_key --cwd /Users/spson/Projects/Claude/codex-plugin-multi --timeout-ms 20000`
- Result: `ready:false`, `selected_route:"direct_api"`, `fallback_reason:"explicit_api"`, `status:"rate_limited"`, `selected_auth_path:"api_key_env"`, `allowed_env_credentials:["ANTHROPIC_API_KEY"]`, `auth_policy:"api_key_env_allowed"`, `source_send_approval_state:"not_required"`, and `detail:"API Error: Repeated 529 Overloaded errors. The API is at capacity -- this is usually temporary. Try again in a moment. If it persists, check status.claude.com."`
- Interpretation: Claude API still exists and is explicit-route only, but current source-free readiness is blocked by provider overload. Source-bearing API review remains approval-gated and was not launched.

## T081 closure follow-up

Observed at `2026-05-22 14:12 KST`.

Claude/Opus availability investigation:

- Public `https://status.claude.com/` reported all systems operational, including Claude Code and Claude API, with no May 22 incident.
- Direct `claude -p` first produced source-free `Repeated 529 Overloaded errors` without selected source.
- Direct sanitized OAuth probes then proved the model split: `claude-sonnet-4-6` succeeded source-free under subscription/OAuth, while `claude-opus-4-7` recovered later and succeeded source-free.
- Companion source-free doctor then returned `ready:true`, `status:"ok"`, `selected_route:"subscription_oauth"`, `fallback_reason:null`, `source_send_approval_state:"not_required"`, ignored `ANTHROPIC_API_KEY`, model `claude-opus-4-7`, and session `d818e993-7453-4150-a120-9f4a0c547d0c`. No selected source was provided or sent by this doctor.
- Interpretation: the earlier T081 source-free blocker was provider/model-route availability, not a current wrapper bug. Claude subscription/OAuth was clean before the T081 source-bearing retry.

T081 RED/GREEN follow-up:

- RED: `node --test tests/unit/default-auth-policy.test.mjs` failed after adding the `args.push("--auth-mode", "auto")` fixture; the scanner missed array-token `--auth-mode` defaults.
- GREEN: `scripts/ci/check-default-auth-policy.mjs` now catches `--auth-mode` followed by comma-separated `"auto"`/`'auto'` argument tokens while still allowing unrelated permission-mode `auto`.
- Local verification passed: `node --test tests/unit/default-auth-policy.test.mjs`, `node --test tests/unit/default-auth-policy.test.mjs tests/unit/ci-workflow.test.mjs` 31/31, `node scripts/ci/check-default-auth-policy.mjs --check`, `npm run lint:sync`, and `git diff --check`.

Source-free readiness before source sends:

- Claude ready: `d818e993-7453-4150-a120-9f4a0c547d0c`, subscription/OAuth, API key ignored, no source sent.
- Gemini ready through `subscription_oauth`, no source sent.
- Grok web ready through `subscription_web`, no source sent.
- DeepSeek ready through `DEEPSEEK_API_KEY`, source-free HTTP 200, no source sent.
- GLM ready through canonical `ZAI_API_KEY`, source-free HTTP 200, no source sent.
- Kimi returned `status:"transient_timeout"` after `--timeout-ms 40000`, `source_send_approval_state:"not_required"`, ignored `KIMI_CODE_API_KEY` and `MOONSHOT_API_KEY`, and no selected source was sent; Kimi was skipped per the operator instruction to skip Kimi if it does not work.

T081 source-bearing review scope was 4 files / 34687 bytes / 688 lines:

- `scripts/ci/check-default-auth-policy.mjs`
- `tests/unit/default-auth-policy.test.mjs`
- `tests/unit/ci-workflow.test.mjs`
- `package.json`

T081 source-bearing review results:

- Claude `8dbc3ae3-4123-4eb6-97d7-95892dc118f2`: source sent, `status:"completed"`, `Verdict: APPROVE`, `review_quality.failed_review_slot:false`.
- Gemini `b6b5c0de-35ad-4fb9-8556-47123852f9cd`: source sent, `status:"completed"`, `Verdict: APPROVE`, `review_quality.failed_review_slot:false`.
- Grok web `job_d82e06ac-eb7f-428d-acb1-580c9c39df2b`: source sent, HTTP 200, `Verdict: APPROVE`, `review_quality.failed_review_slot:false`.
- DeepSeek `job_cf6dc2a1-2a1a-4cdb-bdb4-082ba4e93bc9`: approval-request first returned `source_content_transmission:"not_sent"` for the exact tuple; source sent only with matching approval token; HTTP 200, `Verdict: APPROVE`, `review_quality.failed_review_slot:false`.
- GLM `job_02c21027-cc14-4b54-9a8d-1be712d22487`: approval-request first returned `source_content_transmission:"not_sent"` for the exact tuple; source sent only with matching approval token; HTTP 200, `Verdict: APPROVE`, `review_quality.failed_review_slot:false`.

Interpretation: T081 is closed with RED/GREEN, current source-free readiness proof, source-bearing approvals from all available providers, and an explicit source-free Kimi timeout skip.
