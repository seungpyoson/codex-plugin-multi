# Data Model: Large Custom-Review Packet Recovery

## PacketRecovery

- `schema_version`: integer
- `provider`: provider id, for example `deepseek`, `glm`, `grok`, `claude`,
  `gemini`, or `kimi`
- `mode`: review mode
- `reason`: normalized reason, for example `source_packet_too_large`,
  `prompt_too_large`, `scope_file_too_large`, `review_not_completed`,
  `stale_active_job`, `step_limit_exceeded`, or `timeout`
- `source_content_transmission`: `not_sent`, `may_be_sent`, `sent`, or
  conservative `unknown`
- `failed_review_slot`: boolean or null
- `provider_capabilities`: `ProviderRecoveryCapabilities` snapshot used to
  construct recovery actions
- `review_surface`: `ReviewSurface`
- `actions`: array of `RecoveryAction`

Validation rules:

- If `source_content_transmission` is `sent`, `may_be_sent`, or `unknown`, no
  recovery action may imply the failed slot is approval.
- If an action changes selected source, rendered prompt hash, mode, route,
  provider, auth path, billing path, request settings, or fallback reason, it
  must mark `approval_required:true` for direct API source sends.
- If top-level JobRecord `error_code` exists for a packet recovery failure, it
  must equal `packet_recovery.reason`; `packet_recovery` does not duplicate a
  second `error_code` field.
- No field may contain raw source body, full prompt text, credential value,
  approval token, cookie, bearer token, or private key.
  The JSON schema rejects unknown fields by default, but secret scanning and
  runtime construction tests remain required because schemas cannot prove a
  string is never secret.

## ReviewSurface

- `original_packet_hash`: SHA-256 digest or null
- `current_packet_hash`: SHA-256 digest or null
- `original_files`: count or null
- `current_files`: count or null
- `original_bytes`: count or null
- `current_bytes`: count or null
- `changed`: boolean
- `change_reason`: string or null, for example `shard`, `diff_packet`,
  `narrowed_scope`, `provider_switch`, `same_packet`, or `none`
- `approval_credit`: `full_source`, `changed_surface_only`, `none`, or
  `requires_coverage_proof`
- `coverage_proof`: `CoverageProof` or null

Validation rules:

- `changed:true` implies `approval_credit` is not `full_source` unless a
  separate shard coverage proof is attached.
- Absence of a complete `coverage_proof` means shard/diff approvals cannot be
  summarized as full-source approval for the original packet.
- Hashes are hashes of packet metadata/content digests, never source bodies.

## CoverageProof

- `proof_type`: `complete_shard_set`
- `covered_packet_hash`: SHA-256 digest for the original packet
- `covered_files`: original selected file count
- `covered_bytes`: original selected byte count
- `shard_hashes`: list of shard packet hashes

Validation rules:

- All original selected paths must be covered exactly once before approval
  credit can become `full_source`.
- Coverage proof is not MVP runtime behavior; until implemented, changed
  surfaces remain `changed_surface_only` or `requires_coverage_proof`.

## RecoveryAction

- `type`: `shard`, `diff_packet`, `allow_large_source_packet`,
  `resend_with_confirmation`, `resume_without_source_resend`, `waive_slot`, or
  `switch_provider`
- `description`: bounded operator-facing text
- `command`: suggested command fragment or null
- `source_content_transmission`: expected source-send state for the action
- `review_surface_change`: boolean
- `approval_required`: boolean
- `approval_tuple`: direct API tuple fingerprint/summary or null
- `shards`: array of `ShardPlan` or null

Validation rules:

- `command` is a suggestion, not an automatic execution.
- `allow_large_source_packet` cannot bypass #180 resend confirmation.
- `diff_packet` and `shard` imply `review_surface_change:true`.
- `resend_with_confirmation` after a source-sent failure never changes the
  failed slot's historical verdict; it only describes a new attempt path.

## ShardPlan

- `index`: one-based shard number
- `total`: total shard count
- `scope_paths`: selected path list
- `rendered_prompt_chars`: rendered prompt length estimate or null
- `source_packet`: selected source summary with path, bytes, lines, content hash
- `approval_tuple`: direct API approval tuple fingerprint/summary or null

Validation rules:

- Every shard must fit the provider cap it claims to satisfy.
- For direct API providers, shard tuple must include rendered prompt hash, route,
  fallback reason, auth path, billing path, request settings, and approval scope.
- The approval tuple stores non-secret metadata and hashes only. It must never
  store the approval token value.

## ApprovalTuple

- `provider`: `deepseek` or `glm`
- `mode`: review mode
- `rendered_prompt_hash`: SHA-256 digest
- `source_packet`: selected-source summary for the packet being approved
- `scope_resolution`: scope name, base, paths, and resolution reason
- `scope_paths`: explicit source paths included in the approved packet
- `request_settings`: timeout, max token/step, temperature, stream, and
  request default summary
- `auth_path`: auth mode plus credential reference name, not credential value
- `billing_path`: endpoint/model summary, not secret billing material
- `selected_route`: selected route
- `route_step`: selected route step
- `route_steps`: route-step audit entries
- `fallback_reason`: fallback reason or null
- `approval_scope`: `session` or `one_time`
- `approval_tuple_fingerprint`: structured SHA-256 fingerprint object with
  `algorithm`, `value`, and hashed/non-secret tuple `ingredients`

Validation rules:

- Any changed tuple field for a source-bearing direct API action requires a
  fresh approval-request and matching current-session token.
- The persisted tuple is an audit fingerprint. It is not the approval token and
  cannot authorize source send by itself.

## ProviderRecoveryCapabilities

- `provider`: provider id
- `canonical_provider`: provider id used for shared recovery/audit semantics
  when a transport-specific runtime provider id differs
- `route_step`: selected route step
- `source_packet_budget_bytes`: known source packet cap or null
- `rendered_prompt_budget_chars`: known rendered prompt cap or null
- `per_file_secure_read_cap_bytes`: secure read cap or null
- `supports_diff_packet`: boolean
- `supports_shard_plan`: boolean
- `supports_no_source_resume`: boolean
- `requires_source_send_approval`: boolean
- `requires_resend_confirmation_after_source_sent_failure`: boolean
- `local_source_packet_policy_pre_send`: boolean; true means locally knowable
  source-packet policy failures are evaluated before source-bearing provider
  launch
- `source_sent_runtime_failures_failed_slot`: boolean; true means runtime
  failures discovered after provider launch are represented as source-sent
  failed slots and cannot count as approval
- `transport_fallbacks`: ordered fallback names, for example `cli`, `web`, or
  empty array

Validation rules:

- Shared policy consumes only these facts plus selected source metadata when it
  builds `packet_recovery`.
- Provider adapters must not duplicate recovery semantics; they only expose
  current caps, route, transport, auth, and runtime facts.
- `packet_recovery.provider_capabilities` records these facts at failure time
  so unsupported paths are auditable. For Kimi source-sent step-limit failures,
  `supports_no_source_resume:false` is the structured proof that
  `resume_without_source_resend` is unavailable; recovery actions must omit that
  action and offer resend-confirmation, provider switch, or waiver paths instead.
- Provider parity does not require every runtime failure to be knowable before
  launch. It requires locally knowable source-packet policy failures to fail
  before source send, and post-launch runtime failures to remain source-sent
  failed slots with no approval credit.
- The schema rejects any `packet_recovery` whose
  `provider_capabilities.supports_no_source_resume:false` appears with a
  `resume_without_source_resend` recovery action. The action type remains valid
  only for providers and failure states that explicitly support no-source
  resume.

## Audit Projection

`packet_recovery` should be projected into:

- `review_metadata.audit_manifest.packet_recovery`
- top-level `runtime_diagnostics.packet_recovery` for failures
- lifecycle/status output when present
- review panel rows when compact rendering supports it

Compatibility:

- Existing `sharding_plan` may remain for direct API prompt-cap failures, but it
  should be mirrored into or referenced from `packet_recovery`.
