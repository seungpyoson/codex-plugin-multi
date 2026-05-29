# Data Model: Refresh-Aware Direct API Credentials

## Credential Resolution

- `effective_env`: process env overlaid with usable cache entries for configured
  credential keys.
- `sources`: object mapping configured credential env key name to source.
- `source`: `env_cache`, `env`, or `null`.

Validation rules:

- Cache entries are considered only for configured credential env keys.
- Cache entries override process env for the same configured key only when the
  cache file is readable, owner-only on non-Windows platforms, and the parsed
  value is non-empty.
- Missing, disabled, unreadable, non-owner-only, or empty cache entries do not
  override process env.

## Selected Credential

- `keyName`: selected configured env key name or null.
- `value`: selected effective credential value or null.
- `source`: `env_cache`, `env`, or null.

Validation rules:

- Selection preserves provider config `env_keys` order.
- Secret value is used only for provider authentication/redaction and is never
  emitted.

## Redaction Context

- `effective_env`: current process env overlaid with usable cache entries.
- `selected_credential_value`: in-memory secret value selected for the provider
  request.
- `configured_secret_names`: configured env keys plus synthetic in-memory
  redaction-only names.

Validation rules:

- Redaction includes current effective credentials, stale process env values for
  configured keys, and the selected credential snapshot.
- Redaction-only synthetic names and values are not emitted in JobRecords,
  approval records, diagnostics, or audit manifests.

## Direct API Output Fields

- `credential_ref`: selected configured env key name.
- `credential_source`: `env_cache`, `env`, or null.

Validation rules:

- Doctor success/failure records include source whenever a credential is
  selected.
- Run JobRecords include source whenever provider execution selected a
  credential.
- Missing-key records may omit source or report null.

## Approval Auth Path

- `auth_mode`: provider auth mode.
- `credential_ref`: selected configured env key name or null.
- `credential_source`: `env_cache`, `env`, or null.

Validation rules:

- Source-bearing approvals must compare `credential_source` as part of auth
  path equality.
- No secret value or hash of a secret value is part of the auth path.

## Provider Workload Lease

- `provider`: reviewer provider id.
- `job_id`: active source-bearing job id.
- `pid`: local process id that owns the lease.
- `hostname`: local hostname that wrote the lease.
- `started_at`: ISO timestamp.

Validation rules:

- Leases apply only to source-bearing reviewer runs.
- Source-free readiness probes do not acquire or block on workload leases.
- Dead same-host holders may be reclaimed; active or other-host holders block.
- Blocked runs emit `provider_workload_blocked` before target launch with
  `payload_sent:false`.

## Provider Account Identity

- `provider`: normalized provider slug.
- `identity_source`: currently `provider_auth_status`.
- `identity_fields`: raw account field names observed, such as `email` or
  `org_id`.
- `account_fingerprint`: `{ algorithm: "sha256", value: <64 hex chars> }`.

Validation rules:

- Raw email, account, user, or org values are never emitted.
- The fingerprint is stable for the same provider and normalized account fields.
- Records omit the field when the provider exposes no account identifiers.
