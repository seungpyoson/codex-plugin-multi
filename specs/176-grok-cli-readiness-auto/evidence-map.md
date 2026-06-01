# #176 Grok CLI readiness / transport auto evidence map

## Issue Evidence

- Issue #176 reported repeated `grok_cli_login_required` on the CLI primary path while
  `--transport auto` successfully completed through the subscription web fallback.
- Fresh local doctor evidence on 2026-05-26 shows the current machine has both transports
  ready:
  - `doctor --transport cli`: `ready:true`, `auth_mode:"subscription_cli"`,
    `logged_in:true`, `model_ready:true`, selected CLI binary
    `~/.grok/downloads/grok-0.1.219-$ARCH`.
  - `doctor --transport web`: `ready:true`, `auth_mode:"subscription_web"`,
    chat probe HTTP 200 through `http://127.0.0.1:8000/v1`.
  - `doctor --transport auto`: `ready:true`, `requested_transport:"auto"`,
    `selected_transport:"cli"`, `selected_route:"subscription_cli"`,
    `fallback_reason:null`, and `auto_transport.primary.logged_in:true`.
- A live Grok self-review on the first PR #184 head found a second pre-source
  readiness edge: `doctor --transport auto` selected CLI as ready, but the immediate
  source-free run preflight returned CLI 403 from
  `https://cli-chat-proxy.grok.com/v1/responses`. The selected source was not sent,
  but the failure was classified as generic `grok_cli_failed`, so `--transport auto`
  did not try the ready web fallback.

## Root Cause

`run --transport auto` already treated Grok's CLI and web transports as adapter
capability facts: CLI is tried first, source is sent only after a successful selected
route, and pre-source CLI failures can fall back to subscription web with
`runtime_diagnostics.cli_request` and `fallback_reason` recorded.

The missing piece was `doctor --transport auto`. It reused the CLI doctor output and
stopped after CLI failure, so operators could not see whether auto routing would have
a ready subscription web fallback before launching a review.

The live review also showed that a source-free CLI prompt can fail with 401/403 after
`grok models` reports logged-in/model-ready. That is still a pre-source auth
readiness failure, but it was not mapped to an auto-fallback-eligible reason.

## Fix

- Keep shared route/source policy untouched.
- Add Grok adapter-level auto-doctor reporting:
  - CLI primary readiness is always reported in `auto_transport.primary`.
  - If the CLI primary is ready, auto doctor selects `subscription_cli` and does not
    probe fallback.
  - If the CLI primary fails with an auto-fallback-eligible pre-source reason, auto
    doctor probes the subscription web fallback and reports `selected_route`,
    `fallback_reason`, and `auto_transport.fallback`.
  - The next action preserves the deterministic CLI repair path while making the
    `--transport auto` fallback behavior explicit.
- Classify source-free CLI prompt 401/403 failures as `grok_cli_auth_unavailable`.
  This keeps the failed CLI readiness visible, keeps source transmission as not sent
  for the CLI attempt, and lets explicit auto mode try subscription web with
  `fallback_reason:"grok_cli_auth_unavailable"`.

## Verification Map

- Regression test: `doctor auto transport reports CLI login failure and ready web fallback`.
- Regression test: `custom-review auto transport falls back from source-free Grok CLI
  auth rejection`.
- Existing route test retained: `custom-review auto transport falls back from Grok CLI
  login failure to local web tunnel`.
- Existing budget test retained: `custom-review auto transport preserves CLI diagnostics
  when web fallback prompt is too large`.
- Existing readiness tests retained for explicit CLI-login and explicit web doctor paths.
