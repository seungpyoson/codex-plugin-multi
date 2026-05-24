# Data Model: Provider Architecture Parity Audit

## Provider Parity Table

- `schema_version`: integer
- `feature`: string
- `generated_at`: ISO-8601 date or timestamp
- `providers`: array of provider ids
- `policy_areas`: array of Policy Area records
- `exceptions`: array of Adapter Exception records
- `issue_fit`: Issue Fit record
- `verification`: array of Verification Evidence records
- `guardrail_tests`: array of Guardrail Test records

Validation rules:

- `providers` must include `claude`, `gemini`, `kimi`, `grok`, `deepseek`, and
  `glm`.
- Every policy area must include at least one canonical Module and one
  verification command or test.
- Every provider-specific exception must have a verdict and either a follow-up
  issue link or an explicit null reason when no follow-up issue is needed.

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
- `current_behavior`: current evidence-backed behavior
- `reason`: provider limitation, product decision, packaging constraint, or
  unknown
- `evidence`: source path, issue URL, test path, or command result
- `tests`: guard tests or `missing`
- `verdict`: intentional, accidental, or unknown
- `follow_up_issue`: GitHub issue number or null

Validation rules:

- Exceptions cannot be provider-name product policy without a reason.
- Unknown exceptions must become research/tasks before implementation.

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
- `verdict`: `approved`, `request_changes`, `failed_slot`, `missing`, or
  `timeout`
- `job_or_artifact`: job id, URL, or file path

## Verification Evidence

- `command`: verification command
- `status`: `passed`, `failed`, or `not_run`
- `evidence`: path or note, nullable

Validation rules:

- Unanimity requires every reviewer to return usable `approved`.
- Failed slots, missing verdicts, source-send failures, and timeouts are not
  approvals.
