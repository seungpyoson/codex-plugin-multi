# Research: No-Mistakes Provider Readiness

## Decision: Evidence is per failure class, not per reviewer prose

Root cause work must classify the failing slot before repair. Official review
success requires source-send truth, exact verdict quality, result retrieval, and
visible lifecycle/panel state. Substantive raw prose from a failed quality gate
can inform diagnosis, but cannot count as a successful reviewer slot.

## Decision: Default auth mode must not be `auto`

Claude and Gemini default to subscription/OAuth CLI. DeepSeek and GLM are direct
API providers. Grok defaults to subscription-backed Grok CLI. Operator-facing
`--auth-mode auto` is rejected. API fallback remains available only through the
shared route policy when subscription is unavailable, nonexistent, usage-limited,
or an explicit supported API route is selected with the required source-send
approval.

## Decision: Direct API approval is source-packet scoped

DeepSeek/GLM approval requests are source-free. A granted token is valid only
for the same provider, mode, source packet, prompt hash, scope resolution,
request settings, auth path, and billing path. Changed provider, changed path,
or changed source bytes require a fresh token and must keep source
`not_sent`.

## Decision: Prompt-size overflow is a pre-send failure

DeepSeek/GLM and capped providers must classify oversized payloads as
`prompt_too_large` before sending source. The recovery is sharding or narrowing,
not retrying the same oversized source packet.

## Decision: Grok CLI is the default; tunnel is explicit legacy fallback

Dogfood showed Grok web/tunnel failure before source send. Source-free Grok CLI
proved viable only after the wrapper isolated `GROK_HOME`, linked auth/config
from the real home, disabled memory, used bounded turns, and cleaned prompt/temp
state. Default Grok review now uses CLI. The old grok2api tunnel remains only
for explicit `--transport web` or `GROK_TRANSPORT=web`.

## Decision: Grok uv/session-token failures remain distinct

For explicit legacy web transport, `uv` cache startup, tunnel readiness, and
runtime session tokens are separate failure classes. A writable uv cache does
not prove valid Grok web tokens, and web-token repair needs explicit operator
approval.

## Decision: Visual lifecycle is a runtime contract

The observed infrequent visual expression had a code cause:
`external_review_progress` lacked `external_review`, while markdown rendering
only drew cards from `external_review`. Markdown lifecycle now renders launch,
running/progress, blocked, failed, and completed cards. JSONL remains stable for
machine consumers. One-off `spawnSync` wrappers still buffer child output and
must not be used when live streaming matters.

## Decision: Result lookup must preserve launch workspace

Dogfood showed result fetch failed when the stored job was read from the wrong
workspace or when a user used `--job-id`. The runtime accepts `--job` and
`--job-id`, preserves bounded wrong-workspace diagnostics, and does not silently
switch to unrelated workspaces.

## Decision: Same-path repair is narrower than fallback

Allowed automatic repair is source-free and same-path: validation, prompt budget
checks, result lookup guidance, and same provider/auth/scope/source retry when
no source was sent. CLI login, browser/session sync, grok2api bootstrap, cache
install/upgrade, billing, mutation, and destructive cleanup require explicit
operator approval. Cross-provider fallback is forbidden.

## Decision: Installed cache is part of evidence

Repo tests are insufficient if installed plugin cache differs. After changing
runtime scripts, generated docs/skills, shared libraries, or renderer behavior,
`npm run doctor:cache` must prove marketplace and installed cache match the
source tree used for tests.

## Decision: Live smoke uses synthetic source only

Real project source is not needed to prove wiring. Use git-backed
`/private/tmp` fixtures for source-bearing smoke when needed, and record hashes,
source-send state, quality gate, mutations, prompt-persistence checks, and
cleanup state.
