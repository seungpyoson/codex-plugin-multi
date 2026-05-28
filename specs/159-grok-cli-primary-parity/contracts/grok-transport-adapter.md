# Contract: Grok Transport Adapter Module

## Purpose

The Grok transport Module is the seam where Grok-specific transport capability
facts live. Shared provider policy consumes the resulting route/auth/source
metadata; it does not embed Grok-specific transport branching.

## Required Interface

The Module must expose behavior equivalent to:

```text
resolveGrokTransportMode(options, env) -> "cli" | "web" | "auto" | throws bad_args
resolveGrokConfig(env, options) -> GrokTransportConfig
resolveGrokFallbackConfig(env, options) -> GrokTransportConfig
webAutoFallbackConfig(env, reason) -> GrokTransportConfig
promptBudgetEnvName(config) -> string
canAutoFallbackFromCliExecution(config, execution: GrokCliExecutionSummary) -> boolean
cliRequestDiagnosticsForFallback(execution) -> redacted object
```

Exact names may change during implementation if the Interface remains this
small and tests cover the same contract.

`resolveGrokFallbackConfig` is for generic early-error/fallback record
construction when the runtime cannot build a full selected config.
`webAutoFallbackConfig` is only for the explicit auto-mode transition from a
pre-source CLI failure to the web Adapter and must carry `fallback_from:"cli"`.

## Adapter Facts

CLI Adapter:

- `transport: "cli"`
- `provider: "grok"`
- `display_name: "Grok CLI"`
- `auth_mode: "subscription_cli"`
- `selected_route: "subscription_cli"`
- `prompt_budget_env: "GROK_CLI_MAX_PROMPT_CHARS"`

Web Adapter:

- `transport: "web"`
- `provider: "grok-web"`
- `display_name: "Grok Web"`
- `auth_mode: "subscription_web"`
- `selected_route: "subscription_web"`
- `prompt_budget_env: "GROK_WEB_MAX_PROMPT_CHARS"`

## Fallback Rules

- Auto fallback is available only when requested transport is `auto` and the
  current selected transport is CLI.
- Auto fallback requires the CLI execution to fail before source send.
- Eligible fallback reasons are limited to known CLI readiness/auth/model
  failures.
- Fallback config must record `fallback_from:"cli"` and the exact
  `fallback_reason`.
- Auto fallback must return false when the CLI execution summary says source was
  sent or may have been sent.

## Safety Rules

- The Module must not read or emit secret credential values except through
  existing redacted config fields.
- The Module must not select paid xAI API fallback.
- The Module must not launch the Grok binary, contact the web tunnel, or perform
  browser/session repair. Launch mechanics remain in the runtime.
