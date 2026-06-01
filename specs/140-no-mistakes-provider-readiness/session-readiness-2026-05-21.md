# Session Readiness Probe - 2026-05-21

Scope: source-free readiness only. No selected source was sent.

## Results

| Provider | Probe | Result | Route/auth facts | Source |
| --- | --- | --- | --- | --- |
| Claude | `node plugins/claude/scripts/claude-companion.mjs doctor --auth-mode subscription --cwd ~/projects/relay` | ready | `status:"ok"`, `auth_mode:"subscription"`, `selected_auth_path:"subscription_oauth"`, `selected_route:"subscription_oauth"`, `fallback_reason:null`, ignored `ANTHROPIC_API_KEY`, `auth_policy:"api_key_env_ignored"`, model `claude-opus-4-7`, session `38d1af6d-e921-4370-bf73-ab81fae51aaf` | not sent |
| Gemini | `node plugins/gemini/scripts/gemini-companion.mjs doctor` | ready | `auth_mode:"subscription"`, `selected_auth_path:"subscription_oauth"`, `selected_route:"subscription_oauth"`, `fallback_reason:null`, ignored `GEMINI_API_KEY`, model `gemini-3.1-pro-preview` | not sent |
| Kimi | `node plugins/kimi/scripts/kimi-companion.mjs doctor` | ready | `selected_auth_path:"subscription_oauth"`, `selected_route:"subscription_oauth"`, `fallback_reason:null`, ignored `KIMI_CODE_API_KEY` and `MOONSHOT_API_KEY`, model `kimi-code/kimi-for-coding` | not sent |
| Grok | `node plugins/grok/scripts/grok-web-reviewer.mjs doctor` | ready | `auth_mode:"subscription_cli"`, `transport:"cli"`, binary `~/.grok/downloads/grok-0.1.212-$ARCH`, version `grok 0.1.212 (b7b8204a484)`, `logged_in:true`, `model_ready:true`, `source_free_prompt.status:"ready"`, `prompt_cleanup:"deleted"`, `grok_home_cleanup:"deleted"` | not sent |
| DeepSeek | `node plugins/api-reviewers/scripts/api-reviewer.mjs doctor --provider deepseek` | ready | `credential_ref:"DEEPSEEK_API_KEY"`, HTTP `200`, model `deepseek-v4-pro` | not sent |
| GLM | `node plugins/api-reviewers/scripts/api-reviewer.mjs doctor --provider glm` | ready | `credential_ref:"ZAI_API_KEY"`, HTTP `200`, model `glm-5.1` | not sent |

Current-session recheck after scope correction: Gemini and Kimi source-free doctors returned `ready:true` through `subscription_oauth`; DeepSeek and GLM source-free doctors returned HTTP `200` with source transmission `not_sent`; Grok source-free doctor now returns `ready:true` through the subscription CLI with `logged_in:true` and source-free prompt/home cleanup verified. Follow-up T079 proof initially changed Claude from ready to not ready because OAuth login was present but non-interactive inference returned `oauth_inference_rejected`; after operator login refresh, the same source-free Claude subscription doctor now returns `ready:true` through `subscription_oauth`, ignores `ANTHROPIC_API_KEY`, and still uses no API-key fallback. No selected source was sent by the doctor.

## Cache State

`npm run doctor:cache -- --plugin api-reviewers` returned exit 0 with `ok:false`.

The marketplace cache matches the installed cache, but the repo working tree does not match the installed API-reviewer cache:

- `cache_in_sync:true`
- `repo_cache_in_sync:false`
- Installed cache: `~/.codex/plugins/cache/relay/api-reviewers/0.1.0`
- Missing from the installed repo-cache comparison: `bin/api-reviewer`, `scripts/lib/external-model-failure-catalog.mjs`, `scripts/lib/external-model-failure-core.mjs`, `scripts/lib/external-model-review-quality.mjs`, `scripts/lib/provider-route-policy.mjs`

This is installed-cache/consumer-UX drift only. It is not current-session provider readiness proof and does not change the current DeepSeek/GLM source-free ready state.

## Interpretation

DeepSeek and GLM are no longer `missing_key` in this current repo session. The source-free doctors reached the providers and returned HTTP `200`, with source transmission `not_sent`.

There is no current provider-level source-free readiness blocker in this repo session. The earlier Claude OAuth inference blocker no longer reproduces after the operator login refresh, and the runtime stays on `subscription_oauth` with no API-key fallback.

Claude, Gemini, Kimi, Grok, DeepSeek, and GLM are source-free ready in this current repo session. This artifact does not claim Claude API-key use.
