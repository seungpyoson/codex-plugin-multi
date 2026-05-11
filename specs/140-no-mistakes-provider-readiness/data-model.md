# Data Model: No-Mistakes Provider Readiness

## Provider Row

- `provider`: `claude`, `gemini`, `kimi`, `grok`, `deepseek`, `glm`
- `doctor_status`: `ready`, `not_ready`, `not_run`
- `review_status`: `completed`, `failed`, `not_applicable`, `not_run`
- `failure_class`: `none`, `sandbox`, `auth`, `provider`, `tunnel`, `session_tokens`, `review_quality`, `approval_gate`, `cache_install`
- `source_content_transmission`: `not_sent`, `may_be_sent`, `sent`
- `failed_review_slot`: boolean or null
- `mutation_status`: `clean`, `dirty`, `not_checked`
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
- `selected_files`
- `content_hashes`
