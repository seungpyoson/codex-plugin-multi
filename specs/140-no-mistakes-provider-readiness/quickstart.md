# Quickstart: No-Mistakes Provider Readiness

## Current evidence loop

```sh
npm run doctor:cache

tmp=$(mktemp -d /private/tmp/cpm-perfect-smoke-XXXXXX)
mkdir -p "$tmp/fixtures" "$tmp/records" "$tmp/evidence"
printf 'export function add(a, b) {\n  return a + b;\n}\n' > "$tmp/fixtures/smoke.js"
git -C "$tmp" init
git -C "$tmp" add fixtures/smoke.js
git -C "$tmp" -c user.name='Codex Smoke' -c user.email='codex-smoke@example.invalid' commit -m 'add smoke fixture'
```

Run provider doctors and source-bearing reviews from installed plugin cache.
Write each JSON artifact to:

| Provider | Required evidence files |
| --- | --- |
| Claude | `claude-doctor.json`, `claude-review.json` |
| Gemini | `gemini-doctor.json`, `gemini-review.json` |
| Kimi | `kimi-doctor.json`, `kimi-review.json` |
| Grok | `grok-doctor.json`, `grok-review.json` when source-bearing review is allowed |
| DeepSeek | `deepseek-doctor.json`, `deepseek-approval.json`, `deepseek-review.json` only after approval |
| GLM | `glm-doctor.json`, `glm-approval.json`, `glm-review.json` only after approval |

For direct API providers, run `approval-request` first. Do not run a
source-bearing review until the approval artifact shows
`source_content_transmission: "not_sent"` and the operator has approved the
returned token. If the operator has already approved named direct API providers
in the current turn, do not ask again only when provider, mode, source packet,
prompt hash, scope resolution, request settings, auth path, billing path,
selected route, fallback reason, and approval scope are unchanged. Default
approval scope is `session`, which can be reused only in the current session for
the unchanged tuple. Explicit `once` approval is single-use and rejects replay
before provider launch/source send. Changed provider, mode, source packet,
prompt hash, scope resolution, request settings, auth path, billing path,
selected route, fallback reason, approval scope, or consumed one-time approval
state requires fresh approval. Always generate the per-run approval artifact and
pass its matching token.

Grok has two transport classes:

- Default target: Grok CLI subscription path. It proves immediate source-free
  readiness, neutral cwd, private temp `GROK_HOME`, auth/config symlink,
  prompt-file cleanup, parseable output, timeout behavior, source-send audit
  fields, and log/cache/auth privacy before it sends source.
- Legacy fallback: Grok web/grok2api tunnel. It is explicit only. It must not
  auto-repair browser/session state or auto-bootstrap unreviewed runtime code
  without operator approval.

Grok CLI wrapper contract:

| Area | Required behavior |
| --- | --- |
| Transport selection | Default Grok transport is CLI. Legacy web/tunnel requires `--transport web` or `GROK_TRANSPORT=web` and must never auto-run because CLI failed. |
| Auth and binary | Wrapper checks `grok --version`, records observed version/model/auth evidence, and runs a source-free headless readiness prompt before source send. Current evidence is `grok 0.1.211 (2f2cd6d5c2)`, grok.com login, default model `grok-build`, and no explicit CLI tier field. Auth/login or billing/tier repair is approval-required. |
| Auth expiry | `model_ready:true` is insufficient when `logged_in:false`. Default-browser launch failure, login URL emission, or auth-code timeout must fail closed with `source_content_transmission:not_sent` and actionable auth repair guidance. |
| Working directory | Wrapper runs Grok from a neutral temp cwd unless the operator explicitly opts into repo tool access. Source packet is passed as selected content, not by letting Grok explore the real repo. |
| Prompt sidecar | Wrapper writes prompt/source packet to a private temp file, uses `--prompt-file`, and deletes it on normal exit. Crash or unverifiable cleanup becomes `privacy_persistence`. |
| Grok home | Wrapper runs Grok with a private temp `GROK_HOME`, symlinks auth/config from the source Grok home, disables memory, and deletes the temp home. Unverified cleanup becomes `privacy_persistence`. |
| Tool access | Headless review uses no repo-mutating tools by default. Any allowed tool list must be explicit and recorded in the JobRecord/audit manifest. |
| Source-send truth | `source_content_transmission` stays `not_sent` until the CLI process starts with the source-bearing prompt file. If the process starts and outcome is ambiguous, use `may_be_sent`. |
| Output parse | Wrapper accepts `--output-format json` when available and falls back to bounded plain text only with an explicit parser path. Missing verdict or shallow output still fails review quality. |
| Timeout and cancel | Wrapper has a configured timeout, preserves timeout versus cancelled classification, and records stderr/stdout bounds without storing source bodies. |
| Logs/cache/privacy | Wrapper records paths, hashes, byte/line counts, version, cwd, parse mode, timeout, and cleanup state. It must not persist source bodies, prompt bodies, credentials, session tokens, cookies, or bearer values. |
| Fallback | Grok web/grok2api tunnel is an explicit legacy fallback only. It can never be selected automatically to recover from CLI failure, and browser/session repair remains approval-required. |

Immediate pre-send readiness means:

| Provider path | Required proof before source send |
| --- | --- |
| Claude/Gemini/Kimi CLI | Same-process CLI auth/readiness check; binary exists; subscription/OAuth usable or explicit operator-selected auth path; prompt budget/scope built; stale doctor ignored. |
| Grok CLI | `grok` binary exists; version/model/auth evidence recorded; source-free headless prompt succeeds from neutral cwd; output is parseable; prompt-file path is temp/private; timeout configured; no repo tool access unless wrapper explicitly allows it. Missing `grok-build`, incompatible version, unauthenticated CLI, or unusable tier fails closed before source send. |
| Grok legacy tunnel | Explicit tunnel transport selected; endpoint reachable; model list ready; chat preflight returns expected source-free response; runtime token diagnostics pass; no browser/session repair or auto-bootstrap without approval. |
| DeepSeek/GLM direct API | Local env/config present; rendered prompt below provider cap; approval-request artifact says `not_sent`; matching token proves same provider, mode, source packet, prompt hash, scope resolution, request settings, auth path, billing path, selected route, fallback reason, and approval scope. External provider outage may still happen after source send and must be classified as provider/API failure. |

Safe same-path repair boundaries:

- Automatic: source-free probes, prompt budget checks, scope validation, result lookup guidance, parser/quality classification, retry with same approved source packet when no source was sent.
- Approval-required: browser/session sync, CLI login/reauth, cache install/upgrade, GitHub mutations, destructive cleanup, billing/credit/tier action, grok2api clone/bootstrap, and any repair that touches credentials or local provider state.
- Forbidden: cross-provider fallback, paid Grok/xAI API fallback, default `--auth-mode auto`, source send after failed preflight, source send after approval scope changed, or normalizing an unapproved mutation after it happened.

Privacy boundaries:

- Persist hashes, paths, counts, diagnostics, and bounded stderr/stdout only.
- Do not persist full rendered prompt, selected source bodies, credentials, tokens, cookies, or bearer values in JobRecords, lifecycle cards, manifests, or panels.
- Prompt sidecars must be private temp files, deleted on normal exit, and reported as `privacy_persistence` if cleanup cannot be proven after crash/interruption.
- `source_content_transmission` stays `not_sent` until the provider call that actually carries selected source starts; if upload may have started and failed mid-flight, use `may_be_sent`/unknown rather than pretending not sent.

Visual status contract:

| Surface | Automatic? | Purpose |
| --- | --- | --- |
| Lifecycle markdown card | Yes when `--lifecycle-events markdown` is selected | Per-job launch, running/progress, blocked-before-source, completed, failed, and cancelled status. |
| Review panel | Manual command from lifecycle `Panel` row | Cross-job aggregate by workspace/provider, including stale, failed, cancelled, and missing slots. |
| Readiness manifest | Manual/generated evidence command | Machine-checkable normalized provider readiness and failure classes. |

`--lifecycle-events markdown` must produce terminal-safe markdown for launch,
running/progress, and terminal states. Raw JSONL progress alone is a
`visual_status` failure in markdown mode. `--lifecycle-events jsonl` remains
the compatibility mode for machine consumers and must not change shape.

Lifecycle cards and panel rows must include provider, job id, session id when
known, run kind, mode, scope, source transmission state, status, error code,
bounded message/summary/action, retrieve command, panel command, and disclosure.
They must never print secrets, full prompts, source bodies, cookies, API keys,
or bearer values.

Runtime-rendered output owns lifecycle event formatting. Agent prose may
summarize results, but cannot be the only status surface. Wrapper commands that
launch child reviewers must stream child lifecycle output promptly or classify
the run as `visual_status` before claiming operator-visible progress.

Build the manifest:

```sh
npm run readiness:manifest -- \
  --fixture-root "$tmp" \
  --evidence-dir "$tmp/evidence" \
  --out "$tmp/manifest.json"
```

The manifest is a normalizer, not a provider runner. It classifies missing
direct-API approval as `approval_gate`, approval/source mismatch as
`approval_scope_changed`, prompt budget rejection as `prompt_too_large`, stale
preflight as `preflight_stale`, Grok runtime-token issues as `session_tokens`,
CLI process failures as `cli_runtime`, audit failures as `review_quality`, parse
failures as `parser`, continuation failures as `continuation`, state collisions
as `state_collision`, and persisted full prompt keys as
`privacy_persistence`/`full_prompt_found`. Each row includes `next_action` so
sandbox, approval, cache-install, tunnel, session-token, provider, parser,
continuation, and review-quality failures remain operator-actionable.

Doctor/setup success is never enough by itself for a later source-bearing send.
Every source-bearing path must have immediate pre-send readiness proof, or it
must stop with `preflight_stale`/`missing_evidence`.

## Continuation smoke

After initial source-bearing reviews pass, run continuation for providers that
support follow-up:

```sh
# Provider-specific installed commands; use the plugin runtime paths, not ad hoc
# direct provider calls.
claude continue --job <claude-parent-job-id>
gemini continue --job <gemini-parent-job-id>
kimi continue --job <kimi-parent-job-id>
```

For each continue JobRecord, inspect:

- `parent_job_id`
- provider session id field, such as `claude_session_id`
- `runtime_diagnostics.child_cwd`
- `raw_output.stdout_bytes` / `raw_output.stderr_bytes`
- `error_code` / `error_message`
- `review_quality.failed_review_slot`

Claude continuation is not proven by `--resume <id>` alone. The parent and
continue records must show that the provider session lookup context is reused.
`No conversation found with session ID` is a continuation failure even when the
initial review passed.

## Semantic replay probes

Run two different probe classes:

1. Classifier-only snippets: assert targeted semantic reasons, for example that
   passing prose containing `without permission blocks` does not emit
   `permission_blocked`.
2. Full review-audit samples: include review-shaped output with verdict and
   enough substance to satisfy `missing_verdict` and `shallow_output` gates.

Do not mark a classifier-only snippet as failed because it lacks a full review
verdict. Do mark it failed when the targeted classifier reason is wrong.
Do not count a failed review-quality slot as reviewer approval. Retry is allowed
only as a new recorded slot with its own source-send state, approval token when
required, and persisted quality verdict.

## Workflow mutation gate

Before merge, push, issue closure, GitHub comment, or destructive cleanup, record
explicit current operator approval. If approval is absent or ambiguous, stop and
ask. Do not normalize an unapproved mutation after it happens.

## no-mistakes status

```sh
git push no-mistakes
no-mistakes
```

Repo config runs:

```sh
npm ci && npm run lint && npm run test:full
```

Keep the gate configured, but do not use no-mistakes as authoritative readiness
evidence while `claude-code-oss/claude-config#780` is open. That bug can leave the
review/fix loop non-deterministic after partial fixes. Use direct local
verification plus GitHub CI for merge readiness until the shared tooling issue
is fixed.
