# Data Model: Grok CLI-Primary Transport Parity

## Entity: Grok Transport Adapter

Represents one concrete transport capability for Grok.

Fields:

- `transport`: `cli` or `web`
- `provider`: persisted JobRecord provider id for the selected route
- `display_name`: operator-facing provider name
- `auth_mode`: `subscription_cli` or `subscription_web`
- `selected_route`: shared route name for audit metadata
- `legacy`: whether this Adapter is the explicit legacy web tunnel path
- `prompt_budget_env`: environment variable name used in prompt-budget errors
- `default_model_env`: environment variable name used for default model override
- `timeout_env`: environment variable name used for transport timeout

Validation:

- CLI Adapter must have `transport:"cli"`, `provider:"grok"`, and
  `auth_mode:"subscription_cli"`.
- Web Adapter must have `transport:"web"`, `provider:"grok-web"`, and
  `auth_mode:"subscription_web"`.
- No Adapter may declare a paid xAI API billing path.

## Entity: Grok Transport Request

Represents operator or environment transport selection.

Fields:

- `requested_transport`: normalized value: `cli`, `web`, or `auto`
- `source`: command option or environment variable
- `raw_value`: original input for diagnostics when invalid

Validation:

- `legacy`, `tunnel`, and `grok-web` normalize to `web`.
- Unknown values fail before source send with `bad_args`.

## Entity: Grok Transport Config

Concrete runtime config produced by the transport Module.

Fields:

- Adapter fields copied from the selected Adapter
- selected model
- timeout values
- prompt budget
- CLI binary or web base URL
- fallback metadata: `fallback_from`, `fallback_reason`
- ignored direct API credential metadata

Validation:

- Default config selects CLI.
- Auto config starts with CLI and carries `requested_transport:"auto"`.
- Web fallback config carries `fallback_from:"cli"` and an evidence-backed
  `fallback_reason`.

## Entity: Grok Auto Fallback Decision

Represents whether a CLI failure can route to the web Adapter.

Fields:

- `eligible`: boolean
- `reason`: CLI failure code
- `source_sent`: boolean or source-transmission value
- `cli_diagnostics`: redacted CLI failure diagnostics

Validation:

- Eligible only for configured pre-source CLI readiness/auth/model failures.
- Ineligible when CLI source may have been sent.
- Ineligible for explicit `--transport cli`.

## Entity: Grok CLI Execution Summary

Represents the redacted subset of CLI execution state that the transport Module
may inspect before deciding whether auto fallback is safe.

Fields:

- `exit_code`: numeric process exit code, when known
- `error_code`: normalized CLI failure reason, when known
- `source_sent`: boolean or source-transmission value
- `payload_sent`: legacy boolean or source-transmission value, when present
- `model`: selected CLI model, when known
- `grok_version`: CLI version, when known
- `default_model`: CLI default model, when known
- `logged_in`: CLI auth readiness, when known
- `model_ready`: model readiness, when known
- `exit_status`: process status, when known
- `exit_signal`: process signal, when known
- `stderr_head`: redacted stderr prefix, when present
- prompt/runtime cleanup fields needed for diagnostics

Validation:

- Must be redacted before leaving the runtime.
- Must not include prompt text, selected source text, raw command arguments, raw
  tokens, or direct API credential values.
- `source_sent` or `payload_sent` values that are true, `sent`, or
  `may_be_sent` make auto fallback ineligible.

## Entity: Grok Fallback Diagnostics

Redacted CLI failure summary copied into a web fallback JobRecord.

Fields:

- `transport`
- `error_code`
- `model`
- `grok_version`
- `default_model`
- `logged_in`
- `model_ready`
- `exit_status`
- `exit_signal`
- `stderr_head`
- prompt/runtime cleanup fields

Validation:

- Must not contain prompt text, selected source text, raw tokens, or direct API
  credential values.
- Must preserve enough information to distinguish CLI auth readiness from web
  tunnel success.
