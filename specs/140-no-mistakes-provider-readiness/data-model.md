# Data Model: No-Mistakes Provider Readiness

## Provider Row

- `provider`: `claude`, `gemini`, `kimi`, `grok`, `deepseek`, `glm`
- `doctor_status`: `ready`, `not_ready`, `not_run`
- `review_status`: `completed`, `failed`, provider-specific status string, `not_run`
- `approval_status`: `not_required`, `not_sent`, `missing`, `invalid`
- `failure_class`: `none`, `sandbox`, `auth`, `provider`, `tunnel`, `session_tokens`, `review_quality`, `approval_gate`, `cache_install`, `missing_evidence`
- `next_action`: operator guidance derived from the failure class and evidence
- `source_content_transmission`: `not_sent`, `may_be_sent`, `sent`
- `failed_review_slot`: boolean or null
- `mutation_status`: `clean`, `dirty`, `missing`, `not_checked`
- `prompt_persistence_status`: `hash_only`, `full_prompt_found`, `not_checked`
- `elapsed_ms`: number or null
- `evidence_path`: local path to record or manifest artifact

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
