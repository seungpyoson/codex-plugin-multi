# Data Model: Provider Architecture Parity Audit

## Provider Parity Table

- `schema_version`: integer
- `feature`: string
- `generated_at`: ISO-8601 date or timestamp
- `providers`: array of provider ids
- `policy_areas`: array of Policy Area records
- `semantic_drift_policy`: Semantic Drift Policy record
- `exceptions`: array of Adapter Exception records
- `issue_fit`: Issue Fit record
- `verification`: array of Verification Evidence records
- `guardrail_tests`: array of Guardrail Test records

Validation rules:

- `providers` must include `claude`, `gemini`, `kimi`, `grok`, `deepseek`, and
  `glm`.
- Every policy area must include at least one canonical Module and one
  verification command or test.
- Every provider-specific exception must have a `difference_type`,
  `shared_policy_boundary`, `clear_reason`, evidence, tests, verdict, and
  explicit follow-up issue state.

## Semantic Drift Policy

- `standard`: clear reason rule. Provider differences are allowed only when
  they are Adapter capability facts, documented policy exceptions, known
  accidental drift, or research gaps.
- `allowed_intentional_difference_types`: `adapter_capability_fact` and
  `documented_policy_exception`.
- `tracked_noncompliance_types`: `known_accidental_drift` and `research_gap`.
- `required_exception_fields`: exact Adapter Exception fields enforced by docs
  contract tests.

Validation rules:

- Provider parity must not require fake parity or fake flags.
- Intentional differences must use an allowed intentional difference type and
  include tests.
- Non-intentional differences must remain explicitly classified as drift or
  research gaps until fixed or proven intentional.

## Policy Area

- `name`: route/auth/source-send, packet budget, failure taxonomy, review
  quality, status/UX, generated contracts, packaged copies, docs, sync rules, or
  provider launch mechanics
- `module`: canonical Module path
- `interface`: exported function, contract, generated artifact, or command
  interface
- `implementation`: concise behavior summary
- `adapters`: providers or entrypoints consuming the interface
- `packaged_copies`: package copy paths or `none`
- `sync_guard`: sync script or `none`
- `tests`: test files or commands proving behavior
- `verdict`: one of `compliant_shared_policy`, `intentional_adapter_exception`,
  `accidental_provider_specific_policy`, `packaging_copy_with_sync_guard`,
  `packaging_copy_without_sufficient_sync_guard`, `unknown_needs_research`
- `drift_risk`: low, medium, high
- `missing_guardrail`: string or null

## Adapter Exception

- `provider`: provider id
- `policy_area`: policy area name
- `difference_type`: `adapter_capability_fact`,
  `documented_policy_exception`, `known_accidental_drift`, or `research_gap`
- `current_behavior`: current evidence-backed behavior
- `capability_fact`: provider capability that justifies an intentional
  difference, or null
- `shared_policy_boundary`: exact shared-policy field or route where the
  provider-specific behavior is contained
- `clear_reason`: provider limitation, product decision, packaging constraint,
  or research gap
- `evidence`: source path, issue URL, test path, or command result
- `tests`: guard tests, or explicit `missing: ...` entries for research gaps
- `verdict`: intentional, accidental, or unknown
- `follow_up_issue`: GitHub issue number or null

Validation rules:

- Exceptions cannot be provider-name product policy without a clear reason and
  shared policy boundary.
- Unknown exceptions must become research/tasks before implementation.
- Intentional exceptions must not use `missing: ...` tests.

## Provider Policy Interface

- `provider`: provider id
- `route_ladder`: ordered array of Route Step records
- `packet_policy`: Source Packet Policy record
- `readiness_policy`: shared readiness/auth state contract
- `failure_policy`: shared failure taxonomy and suggested action contract
- `status_policy`: shared lifecycle/status/review-panel field contract
- `review_quality_policy`: shared verdict/failed-slot contract

Validation rules:

- Every provider must expose the same policy Interface.
- Provider-specific behavior must be represented as Adapter capability facts.
- Unsupported route steps are capability facts, not policy exceptions.

## Route Step

- `route`: `subscription`, `direct_api`, or `openrouter`
- `capability_status`: `available`, `unsupported`, `not_configured`,
  `not_authenticated`, `usage_limited`, `unavailable`, or `unknown`
- `attempted`: boolean
- `selected`: boolean
- `skipped_reason`: string or null
- `fallback_reason`: string or null
- `auth_path`: string or null
- `billing_path`: string or null
- `source_send_approval_required`: boolean
- `source_send_approval_state`: `not_required`, `required`, `approved`, or
  `blocked`
- `source_content_transmission`: `not_sent`, `may_be_sent`, `sent`, or
  `unknown`
- `error_code`: string or null
- `suggested_action`: string or null

Validation rules:

- Route order is always subscription -> direct API -> OpenRouter.
- The policy must record unsupported steps before evaluating later steps.
- Billing-path changes require approval tuple changes before source send.
- Fallback after source send is blocked unless the shared resend policy permits
  it.

## Adapter Capability Fact

- `provider`: provider id
- `route`: route step the fact applies to
- `capability`: subscription Adapter, direct API Adapter, OpenRouter Adapter,
  prompt budget, byte budget, step budget, model availability, auth probe, or
  transport
- `status`: available, unsupported, not configured, unavailable, unknown
- `evidence`: source path, config path, issue URL, or command result
- `tests`: proving tests or missing-test task

Validation rules:

- Capability facts may explain different treatment only when evidence and tests
  are present.
- Capability facts must not duplicate product policy in provider entrypoints.

## Source Packet Policy

- `mode`: `review`, `adversarial-review`, `custom-review`, or `rescue`
- `source_surface`: branch diff, selected source, diff packet, shard, or rescue
  packet
- `file_bytes`: selected file total
- `rendered_prompt_bytes`: rendered prompt total
- `provider_budget`: Adapter-provided limit record
- `decision`: `within_budget`, `over_budget`, `requires_split`,
  `requires_override`, or `unknown`
- `source_send_allowed`: boolean
- `retry_allowed`: boolean
- `retry_fingerprint`: stable identity for same-packet retry comparison
- `retry_count`: integer count of prior attempts with the same fingerprint
- `retry_disposition_required`: boolean
- `request_settings_hash`: hash of model, timeout, step, token, temperature,
  and stream settings; stored for audit, not for resetting retry identity
- `resend_requires_confirmation`: boolean
- `surface_changed`: boolean
- `previous_attempt_id`: job id or artifact id for the previous attempt, or
  null
- `previous_attempt_error_code`: failure code from the previous attempt, or
  null

Validation rules:

- One packet policy must cover all six providers and all review modes.
- Provider limits are Adapter capability facts.
- Over-budget predictable failures should happen before source send.
- Full-source to diff/shard changes must be audited and cannot count as the
  original review surface approval.
- Same-packet retry identity must include provider, mode, rendered prompt hash,
  selected source hash/counts, reviewed head SHA, route step, scope name,
  scope base, and canonicalized relative scope paths or path HMACs.
- Failure code and request settings are reported fields. They must not reset
  the same-packet retry count; changing them requires explicit disposition.
- After one same-packet retry, another retry must fail closed until disposition
  is split/narrow, switch provider, waiver, or explicit override.

## Guardrail Test

- `name`
- `file`
- `purpose`
- `red_condition`
- `green_condition`
- `verification_command`
- `required_fields`: exact shared field names enforced by the test
- `required_interfaces`: exact shared interfaces/imports enforced by the test

Validation rules:

- Route/audit/status guardrails must enforce `selected_route`,
  `fallback_reason`, `approval_scope`, `auth_path`, `billing_path`,
  `source_bearing`, `source_send_approval_required`,
  `source_send_approval_state`, `source_content_transmission`,
  `review_quality.failed_review_slot`,
  `review_quality.semantic_failure_reasons`, `error_code`, and
  `suggested_action`.
- Source-consumption guardrails must enforce use of `selectProviderRoute`,
  `buildReviewAuditManifest`, `SOURCE_CONTENT_TRANSMISSION`,
  `buildExternalModelFailureDiagnostic`, and `reviewQualityFailureState` where
  the provider path exposes the related policy surface.
- Review-slot guardrails must enforce the shared retry/disposition interfaces,
  including `reviewSlotRetryFingerprint` and `buildReviewSlotDisposition`, once
  the #180 implementation slice begins.

## Issue Fit

- `primary_issue`: expected `171`
- `evidence_issue`: expected `170`
- `related_issues`: array of issue numbers
- `new_issue_required`: boolean
- `split_recommendation`: string or null

## External Review Gate

- `stage`: `plan_tasks` or `final`
- `reviewers`: Claude, Gemini, Grok, GLM, DeepSeek, Kimi
- `source_packet`: source files/counts/hash summary
- `reviewed_head_sha`: exact head SHA reviewed
- `slot_id`: stable provider/mode/head/packet slot id
- `attempt_id`: job id or artifact id for this attempt
- `parent_attempt_id`: prior attempt id for retry/continue, or null
- `retry_fingerprint`: same-packet retry identity
- `retry_count`: integer
- `request_settings_hash`: request settings hash for audit, or null
- `source_state`: `not_sent`, `sent`, or `unknown`
- `verdict`: `approved`, `request_changes`, `failed_slot`, `missing`, or
  `timeout`
- `failed_slot_reason`: provider-neutral enum, or null
- `disposition`: `none`, `retry`, `split`, `switch_provider`, `waive`,
  `accept`, or `override`
- `not_counted_reason`: `none`, `stale_head`, `source_not_sent`,
  `source_sent_unusable`, `missing_verdict`, `timeout`, `usage_limited`,
  `sandbox_rejected`, `operator_waived`, or `unknown`
- `waiver_artifact`: path/id when disposition is `waive`, else null
- `override_artifact`: path/id when disposition is `override`, else null
- `job_or_artifact`: job id, URL, or file path

## Verification Evidence

- `command`: verification command
- `status`: `passed`, `failed`, or `not_run`
- `evidence`: path or note, nullable

Validation rules:

- Unanimity requires every reviewer to return usable `approved`.
- Failed slots, missing verdicts, source-send failures, and timeouts are not
  approvals.
- Historical approvals cannot count when `reviewed_head_sha` differs from the
  current head.
- Any failed or missing slot must end with explicit disposition before
  completion can be claimed.
- `waive` and `override` dispositions require an artifact reference. Artifact
  references must be relative project paths or stable ids, not absolute
  filesystem paths.
- Disposition fields must not store raw source, prompts, provider output, raw
  command args, or raw filesystem paths.
