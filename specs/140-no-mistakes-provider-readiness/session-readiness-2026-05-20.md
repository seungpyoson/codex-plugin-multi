# Session Readiness Probe - 2026-05-20

Probe time: 2026-05-20T14:15:53Z

Scope: source-free readiness only. No selected source was sent. Direct API provider calls were not made in this artifact.

## Results

| Provider | Probe | Result | Route/auth facts | Source |
| --- | --- | --- | --- | --- |
| Claude | `node plugins/claude/scripts/claude-companion.mjs doctor --auth-mode subscription` | ready | `selected_route:"subscription_oauth"`, `fallback_reason:null`, ignored `ANTHROPIC_API_KEY` | not sent |
| Gemini | `node plugins/gemini/scripts/gemini-companion.mjs doctor --auth-mode subscription` | ready | `selected_route:"subscription_oauth"`, `fallback_reason:null`, ignored `GEMINI_API_KEY` | not sent |
| Kimi | `node plugins/kimi/scripts/kimi-companion.mjs doctor` | ready | first-party CLI auth, ignored `KIMI_CODE_API_KEY` and `MOONSHOT_API_KEY` | not sent |
| Grok | `node plugins/grok/scripts/grok-web-reviewer.mjs doctor` | not ready | `auth_mode:"subscription_cli"`, `transport:"cli"`, `logged_in:false`, `model_ready:true`, `error_code:"grok_cli_login_required"` | not sent |
| DeepSeek | env-presence only | key present in this Codex process | `DEEPSEEK_API_KEY=present` | not sent |
| GLM | env-presence only | key present in this Codex process | `ZAI_API_KEY=present`; current supported GLM credential path is only `ZAI_API_KEY` | not sent |

## Interpretation

Other sessions that report DeepSeek/GLM `missing_key` are seeing different process environment than this session. Current process has the canonical DeepSeek and Z.ai/GLM credential names present, but this artifact intentionally did not call the API provider because direct API probes can spend money even without source.

Other sessions that report Grok browser/OAuth timeout match current live state: local Grok CLI binary and model list are reachable, but CLI auth is not logged in. The runtime correctly fails before source send with `grok_cli_login_required`; it does not fall back to xAI API keys.

Claude/Gemini/Kimi are currently source-free ready in this process using subscription/OAuth CLI routes. The Claude doctor output included a `cost_usd` field despite `selected_route:"subscription_oauth"`; this artifact records that as route telemetry, not proof of API-key use.
