# Data Model: Bounded Session Approval

## Entity: Grant Request

A source-free request describing the bounded permission the operator is being asked to approve.

Fields:
- `event`: `external_review_session_approval_request`
- `provider`: Direct API provider id, initially `deepseek` or `glm`
- `display_name`: Provider display name
- `mode`: `review`, `adversarial-review`, or `custom-review`
- `workspace_root_hash`: Stable hash of the resolved workspace root; raw home paths are not persisted
- `scope`: Requested scope
- `scope_paths`: Explicit selected paths when present
- `selected_source`: Existing selected-source summary with file paths, byte/line counts, and content hashes
- `rendered_prompt_hash`: Existing rendered prompt hash object
- `scope_resolution`: Existing scope-resolution audit object
- `request`: Provider/model/request settings
- `selected_route`, `route_step`, `route_steps`, `fallback_reason`: Shared route metadata
- `auth_path`: Auth metadata with key name only
- `billing_path`: Endpoint/model metadata without secrets
- `approval_scope`: Always `grant`
- `grant_bounds`: Provider allowlist, mode allowlist, workspace root hash, path constraints, max files, max bytes, expiry, maximum TTL, and grant schema version
- `grant_bounds.expires_at`: Concrete request expiry timestamp. Activation must reuse this exact value instead of recomputing expiry from `--grant-ttl-ms`.
- `grant_approval_token`: Activation proof for this exact grant request; token value is printed only in the source-free request response and never persisted after activation
- `source_content_transmission`: Always `not_sent`

Validation:
- Provider must be configured and Direct API only.
- Mode must be source-bearing review mode.
- Grant request must include an explicit `--grant-ttl-ms`; there is no implicit default TTL.
- Max file and byte bounds must be positive and no smaller than the selected source.
- Expiry must be in the future and no greater than the configured maximum TTL.
- Grant approval proof must be computed over the canonical approval tuple plus grant bounds.
- Because `grant_bounds.expires_at` is part of the proof, activation input must include the exact `expires_at` emitted by the request.
- Request output must not include selected-source bodies or secret values.

## Entity: Session Approval Grant

A persisted source-free authorization that can satisfy future matching Direct API runs until it expires.

Fields:
- `schema_version`
- `grant_id`
- `created_at`
- `expires_at`
- `grant_session_id`
- `provider_allowlist`
- `mode_allowlist`
- `workspace_root_hash`
- `path_constraints`
- `max_files`
- `max_bytes`
- `max_ttl_ms`
- `approval_fingerprint`
- `approval_tuple`: canonical nested payload containing provider, mode, selected source, rendered prompt hash, request, scope resolution, auth path, billing path, selected route, route step, route steps, fallback reason, approval scope `grant`, and `grant_bounds`
- `activation`: source-free activation metadata without token value

Validation:
- Grant file must be JSON object with expected schema version.
- Grant id must be safe for filesystem use.
- Grant must be ignored if expired, malformed, unreadable, or outside the current workspace hash.
- Grant cannot authorize a selected source exceeding `max_files` or `max_bytes`.
- Grant cannot authorize a provider or mode outside allowlists.
- Persisted top-level bound fields must match `approval_tuple.grant_bounds`.
- `approval_fingerprint` must equal `sha256` over stable canonical JSON for `approval_tuple`.
- Canonical JSON must sort object keys by ascending UTF-16 code unit order, preserve array order after deterministic tuple construction, use `JSON.stringify` scalar encoding, emit no insignificant whitespace, reject non-finite numbers, and hash UTF-8 bytes of the canonical string.
- `selected_source.files` and `path_constraints.scope_paths` must be sorted before tuple construction so semantically identical path selections do not produce different fingerprints.
- `approval_tuple` must reject unknown top-level fields.
- Normal source-bearing approval tokens and `approval_scope:"once"` tokens cannot activate grants.
- Grant-scoped tokens cannot authorize normal source-bearing `run --approval-token` execution.
- `grant_session_id` is an audit id only and must not be used as a filesystem path component.
- `approval_fingerprint` is not a signature or MAC; local plugin data remains a trusted local filesystem boundary.

## Entity: Grant Match Result

Runtime classification produced before any provider launch/source send.

Fields:
- `matched`: boolean
- `grant_id`: set only when matched
- `grant_session_id`: set when matched and available
- `approval_source`: `session_grant`, `approval_token`, or `none`
- `mismatch_reasons`: safe bounded strings for diagnostics
- `source_content_transmission`: `sent` only after provider call begins; `not_sent` for every mismatch

Validation:
- Mismatch diagnostics must not include raw source bodies, prompt text, tokens, or secrets.
- If `matched` is false, provider launch must not occur unless a separate valid per-request approval token is present.
- If more than one grant matches, `matched` must be false with a safe ambiguity reason.
- `scope_paths:null` must be treated as a literal resolved scope state, never as a wildcard.

## Entity: Grant Audit Manifest Extension

Fields added to `review_metadata.audit_manifest` for grant-approved runs.

Fields:
- `approval_source`: `session_grant`
- `approval_grant`: object with `grant_id`, `grant_session_id`, `created_at`, `expires_at`, `matched_at`, `max_files`, `max_bytes`
- Existing `approval_scope`, `source_send_approval_required`, `source_send_approval_state`, `selected_source`, `rendered_prompt_hash`, `request`, `auth_path`, `billing_path`, selected route, route step, route steps, and fallback reason

Validation:
- `source_send_approval_state` must be `approved` on matched grant-approved source-bearing runs.
- `source_content_transmission` must be `sent` only if the provider call is actually launched.
- No approval token value is persisted.

## State Transitions

1. `requested`: Grant request emitted; source not sent; no grant persisted.
2. `active`: Matching approval proof activated; grant persisted with expiry.
3. `matched`: A later run matches the grant before provider launch.
4. `expired`: Current time is after `expires_at`; grant ignored.
5. `rejected`: Grant file or tuple does not match; run falls back to per-request approval or fails `approval_required`.
