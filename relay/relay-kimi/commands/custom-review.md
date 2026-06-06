---
description: Ask Kimi to review explicit files.
argument-hint: "--scope-paths <files> [--timeout-ms MS] [review prompt]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

# Kimi Custom Review

EXTERNAL_MODEL_CONTRACT_VERSION=1

`$ARGUMENTS` is required `--scope-paths <files>`, optional `--timeout-ms MS`, and review prompt text.
Route `--scope-paths <files>` before `--prompt-file` and write the remaining prompt text to the private prompt file referenced by `RELAY_PROMPT_FILE`.
Review timeout defaults to 900000 ms. Use `--timeout-ms <ms>` or `KIMI_REVIEW_TIMEOUT_MS`; the effective value is persisted in `review_metadata.audit_manifest.request.timeout_ms`.

Prompt payload:
Write the routed focus text to a private temp file (mode 0600), set `RELAY_PROMPT_FILE` to that path, and delete it after the command exits.

Run:

- `node "${CLAUDE_PLUGIN_ROOT}/scripts/relay-run.mjs" kimi-companion.mjs run --mode=custom-review --scope custom --scope-paths "<file1>,<file2>" --foreground --lifecycle-events markdown --prompt-file "$RELAY_PROMPT_FILE"`

## Review Contract
This is a review-only contract.
Do not fix findings, apply patches, edit files, or start rescue work from a review result.
Preserve the caller's review text verbatim after routing documented flags.
Return the runtime output verbatim; do not summarize or rewrite findings.
If there is no substantive result or structured output, report review blocked / no findings produced.
Render lifecycle markdown cards directly.

Use the current Claude Code execution environment for each source-bearing `run` command after approval.
Do not broaden local execution access for a normal source send; use broader access only for source-free setup or access repair after a `sandbox_blocked` result.
If local execution blocks provider auth, job state, temp files, or network access, stop and report `sandbox_blocked` with `source_content_transmission: "not_sent"` instead of retrying the same source send with broader local access.

## Scope Safety
Use custom-review only for explicit file bundles. Scope validation must complete before selected source is sent.
If concrete files or --scope-paths are already known, do not run branch-diff first; use custom-review with those paths and the original prompt.

## Secret Safety
Do not print raw OAuth tokens, API-key values, session cookies, tunnel API keys, bearer tokens, or raw secret values.
Credential diagnostics may show key names only.
