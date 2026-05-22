# Data Model: No-Mistakes Provider Readiness

## Provider Row

- `provider`: `claude`, `gemini`, `kimi`, `grok`, `deepseek`, `glm`
- `doctor_status`: `ready`, `not_ready`, `not_run`
- `review_status`: `completed`, `failed`, provider-specific status string, `not_run`
- `approval_status`: `not_required`, `not_sent`, `missing`, `invalid`
- `error_code`: normalized top-level or nested diagnostic error code, or null
- `failure_class`: `none`, `sandbox`, `auth`, `oauth_rejected`, `quota_or_rate_limit`, `provider`, `content_policy_refusal`, `prompt_too_large`, `tunnel`, `session_tokens`, `review_quality`, `approval_gate`, `approval_scope_changed`, `cache_install`, `parser`, `transport`, `cli_runtime`, `source_selection`, `preflight_stale`, `privacy_persistence`, `continuation`, `state_collision`, `interrupted_source_transmission`, `cancelled`, `workspace_identity`, `visual_status`, `workflow_gate`, `missing_evidence`
- `next_action`: operator guidance derived from the failure class and evidence
- `source_content_transmission`: `not_sent`, `may_be_sent`, `sent`
- `failed_review_slot`: boolean or null
- `mutation_status`: `clean`, `dirty`, `missing`, `not_checked`
- `prompt_persistence_status`: `hash_only`, `full_prompt_found`, `not_checked`
- `elapsed_ms`: number or null
- `evidence_path`: local path to record or manifest artifact

Validation rules:

- `approval_scope_changed` means approval token or current-turn approval no longer matches provider, mode, source packet, prompt hash, scope resolution, request settings, auth path, or billing path. Source must remain `not_sent`.
- `prompt_too_large` means provider prompt budget rejected request before source send. Operator must split or narrow packet before retry.
- `preflight_stale` means prior doctor/setup evidence exists but immediate pre-send readiness proof is missing or expired.
- `privacy_persistence` means prompt sidecar, selected source, JobRecord, lifecycle, or panel output may persist or display source beyond declared policy.
- `transport` means the selected transport could not carry a request/response reliably after scope and auth were accepted; use `tunnel` for Grok tunnel startup/readiness, `cli_runtime` for local CLI process failures, and `provider` for a reachable provider service returning API/provider errors.
- `cli_runtime` covers missing binary, CLI auth failure, sandbox FS denial, max-turn/accounting failure, nonzero exit, timeout, malformed JSON/plain output, and missing parseable result.
- `source_selection` means the requested scope resolves to zero files, wrong files, a broken symlink, or a path outside the declared source packet before provider send.
- `interrupted_source_transmission` means the provider call may have started carrying selected source but no trustworthy completion/error boundary exists; `source_content_transmission` must be `may_be_sent`.
- `cancelled` means the operator or runtime intentionally stopped a job and the JobRecord must distinguish it from provider failure.
- `workspace_identity` means result lookup, continuation, or provider session lookup used the wrong workspace/root/cwd.
- `content_policy_refusal` means the provider returns a successful transport response but refuses to review the selected packet.
- `visual_status` means lifecycle, panel, or manifest output hid launch/running/terminal state behind raw JSON/prose, buffering, or missing retrieve/panel guidance.

## Readiness Manifest

- `schema_version`
- `fixture`
- `providers`
- `summary`
- `created_at`

## Synthetic Fixture

- `path`
- `head_sha`
- `status_porcelain`: tracked and untracked fixture mutations from `git status --porcelain=v1 --untracked-files=all`
- `selected_files`: tracked fixture files only
- `selected_files[].content_hash`: SHA-256 hash of tracked fixture content

## Evidence File Contract

The manifest builder reads JSON artifacts from one evidence directory:

- `<provider>-doctor.json`
- `<provider>-review.json`
- `<provider>-approval.json` for `deepseek` and `glm`

Valid providers are `claude`, `gemini`, `kimi`, `grok`, `deepseek`, and `glm`.
The manifest builder never persists fixture source bodies. Prompt persistence
is classified as `full_prompt_found` if evidence contains a full prompt carrier
such as `prompt`, `rendered_prompt`, `prompt_text`, `renderedPrompt`,
`promptText`, `system_prompt`, `developer_prompt`, `user_prompt`, or
`messages[].content`.

## Continuation Record

Parent and follow-up JobRecords used to prove reviewer continuation.

- `parent_job_id`: plugin job id from the initial review
- `continue_job_id`: plugin job id from the follow-up run
- `provider_session_id`: provider conversation/session id used with `--resume` or equivalent
- `session_lookup_context`: bounded provider runtime context required to resolve the session, including provider project/cwd when applicable
- `child_cwd`: runtime cwd recorded in JobRecord diagnostics
- `source_scope`: source selection mode used by parent and continue
- `stdout_bytes` / `stderr_bytes`: bounded output sizes
- `error_code` / `error_message`: top-level failure diagnostics
- `failed_review_slot`: authoritative audit flag

Validation rules:

- `provider_session_id` must not be inferred from `parent_job_id` unless the provider record proves that value is the actual provider session id.
- For Claude, `session_lookup_context` must remain stable across parent and continue.
- A continue failure with empty stdout and actionable stderr must preserve the stderr cause without storing full prompts or source bodies.

## Semantic Replay Probe

Synthetic text replayed through parser/audit logic.

- `mode`: `classifier_only` or `full_review_audit`
- `input_text`: synthetic text, never real project source
- `expected_reasons`: exact semantic failure reasons expected
- `expected_failed_review_slot`: boolean for full-audit probes; null for classifier-only probes when verdict/substance gates are intentionally out of scope

Validation rules:

- `classifier_only` probes must assert only the targeted classifier result.
- `full_review_audit` probes must include review-shaped output with verdict and sufficient substance.

## Operator Approval Gate

Evidence that a workflow mutation was explicitly approved.

- `operation`: `merge`, `push`, `issue_close`, `comment`, `destructive_cleanup`, or `source_send`
- `approval_source`: current operator instruction or generated approval token
- `approved_at`: timestamp or null
- `status`: `approved`, `blocked`, or `not_required`
- `scope_hash`: hash of approved provider, mode, source packet, prompt hash, scope resolution, request settings, auth path, and billing path when operation is `source_send`
