# Redaction surface

Redaction is **not** uniform across plugins. Three separate implementations protect against three different leak vectors. Treating "redaction" as a single contract conflates them.

## 1. Companion plugins — env-stripping pre-launch (`sanitizeTargetEnv`)

**Canonical source:** `scripts/lib/provider-env.mjs`, synced via `scripts/ci/sync-provider-env.mjs`. Used by claude, gemini, kimi.

**What it protects:** the env block passed to the spawned target CLI. Without this, env vars meant for one provider could route the target CLI to a competing provider's endpoint, or leak credentials.

**Strategy:** drop matching keys from the spawn env. No string substitution; the values never reach the child process.

**What gets stripped** (`provider-env.mjs:48-57`):

1. **Any `*_API_KEY` env var** (case-insensitive suffix), unless explicitly listed in `options.allowedApiKeyEnv`.
2. **Provider-prefix env vars** (`provider-env.mjs:29-39`):
   - `ANTHROPIC_*`
   - `CLAUDE_CODE_USE_*` (e.g., `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`)
   - `OPENAI_*`
   - `AWS_*`
   - `AZURE_*`
   - `VERTEX_*`
   - `GOOGLE_CLOUD_*`
   - `LITELLM_*`
   - `OLLAMA_*`
3. **Explicit denylist** (`provider-env.mjs:40-46`):
   - `GOOGLE_APPLICATION_CREDENTIALS`
   - `GOOGLE_GENAI_USE_VERTEXAI`
   - `CLOUD_ML_REGION`
   - `CODEX_PLUGIN_STRIP_PROXY_ENV` (companion control variable, never forwarded)
4. **Optional: proxy env vars** (`*_PROXY`) — only if `CODEX_PLUGIN_STRIP_PROXY_ENV=1` (`provider-env.mjs:59-69`). Default keeps `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` because corporate networks need them for OAuth refresh.

**What survives:** `PATH`, `HOME`, terminal vars, `NODE_*`, target CLI config dirs (`CLAUDE_CONFIG_DIR`, `GEMINI_CONFIG_DIR`).

**Companion stdout/stderr is NOT redacted** in the JobRecord output path. The contract relies on the env-strip preventing secrets from leaking *into* stdout/stderr in the first place; there is no post-hoc string scrub.

## 2. grok — output-time JSON-tree redaction

**Canonical source:** `plugins/grok/scripts/grok-web-reviewer.mjs:190-231`.

**What it protects:** error messages, response bodies, and the final JobRecord-shaped output. grok is a single-process direct-HTTP architecture with no spawned target, so env-stripping isn't the relevant defense.

**Strategy:** build a `redactor(env)` from the current env (factory at `grok-web-reviewer.mjs:190-223`), then walk values via `redactValue(value, redactor)` (`grok-web-reviewer.mjs:225-231`) and substitute. Replacement token unspecified in agent's report (likely `[REDACTED]`; verify in source on next read).

**What gets redacted:**

- Env values for any env-key matching `/(?:API_KEY|TOKEN|COOKIE|SESSION|SSO)/i` AND with a value of length ≥8.
- Recursively across JSON objects and arrays.

**Where applied:**

- All error messages (`grok-web-reviewer.mjs:1298, 1364, 1439, 1451-1455, 1472`).
- Final record before printing (`grok-web-reviewer.mjs:1480-1488`).
- List command responses (`grok-web-reviewer.mjs:1321`).

**Auxiliary:** `plugins/grok/scripts/grok-sync-browser-session.mjs:97-98, 351-355` masks Authorization/Bearer/admin-key headers when emitting status from the cookie-import flow.

## 3. api-reviewers — output-time pattern + structured redaction

**Canonical source:** `plugins/api-reviewers/scripts/api-reviewer.mjs:632-663`.

**What it protects:** result text, error messages, and the entire persisted JobRecord (stdout + on-disk `meta.json`). api-reviewers calls providers via `fetch()`, so an echo-attack (provider returning a string that contains the caller's API key) can reach the result body — output redaction is the only defense.

**Strategy:** `redactor()` returns a function that takes a string and substitutes matched substrings with the literal `[REDACTED]`. Applied recursively via `redactValue()` (`api-reviewer.mjs:654-663`).

**Patterns matched** (`api-reviewer.mjs:632-652`):

1. **Configured secrets**: every value listed in the resolved provider config's `cfg.env_keys`, when ≥ `MIN_SECRET_REDACTION_LENGTH` (= 8) characters. Replaced with `[REDACTED]`.
2. **Auto-detected secret env vars**: env keys matching `/(?:^|_)(?:API_KEY|TOKEN|ACCESS_KEY|SECRET|ADMIN_KEY)$/`, with value length ≥8. Replaced with `[REDACTED]`.
3. **Authorization headers**: `Authorization:\s*\S.*$` (any case). Replaced with `Authorization: [REDACTED]`.
4. **Bearer tokens**: `Bearer\s+\S+` (any case). Replaced with `Bearer [REDACTED]`.

**Why the 8-char threshold:** prevents one-byte collision false positives. A `DEEPSEEK_CREDENTIAL="a"` env value won't redact every standalone `"a"` in output. Verified by smoke test `tests/smoke/api-reviewers.smoke.test.mjs:1455-1467`.

**Where applied** (`api-reviewer.mjs:1637, 1668`):

- Result text.
- Error messages.
- Entire record via `redactRecord()` before stdout print AND before on-disk persist.

**Echo-attack handling:** no separate error code. If the provider response contains a configured secret, the redaction strips it from `result` before the JobRecord is printed or persisted. Tested at `tests/smoke/api-reviewers.smoke.test.mjs:1347-1359`.

## Summary table

| Plugin | Surface | Mechanism | Replacement | Threshold |
|---|---|---|---|---|
| claude | spawn env | drop key | n/a (key never passed) | n/a |
| gemini | spawn env | drop key | n/a | n/a |
| kimi | spawn env | drop key | n/a | n/a |
| grok | output (errors + JSON tree) | regex match → substitute | unverified (likely `[REDACTED]`) | ≥8 chars |
| api-reviewers | output (stdout + persisted meta.json) | regex match + Authorization/Bearer patterns → substitute | `[REDACTED]` | ≥8 chars (configured secrets), no threshold for Authorization/Bearer |

## Implications for property-based testing

- **Companion**: a property test asserting "no secret-shaped substring appears in stdout/stderr" tests an invariant that the env-strip is *supposed* to enforce indirectly. It cannot fail unless the target CLI itself leaks the env value. The right property is "env passed to spawned target excludes any key in the redaction surface" — this is a unit-level property over `sanitizeTargetEnv`, not a smoke-level property over stdout.
- **grok / api-reviewers**: the property "configured secret value never appears literally in `result` or `error_message`" is testable end-to-end because the redaction path runs in the same process before output. This is a real smoke-level invariant.

Net: the redaction property in the original spec was authored as if all five plugins shared one mechanism. They don't. Three separate properties are needed, each scoped to its actual surface.

## Test surface

- Companion env-strip: covered by `tests/unit/claude-dispatcher.test.mjs`, `tests/unit/gemini-dispatcher.test.mjs`, and provider-env unit assertions.
- grok output: smoke tests in `tests/smoke/grok-web.smoke.test.mjs` exercise redactor on responses.
- api-reviewers output: extensive — `tests/smoke/api-reviewers.smoke.test.mjs:1347-1359` (echo-attack), `:1455-1467` (one-byte collision protection), and others under "redact" titles.
