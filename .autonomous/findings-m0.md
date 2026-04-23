# M0 adversarial-review findings + disposition

Reviewer: `general-purpose` subagent, invoked with adversarial-review role prompt.
Run at: 2026-04-24 (early-morning autonomous session).

All 15 findings below; HIGH + MEDIUM addressed inline before commit. LOW
accepted or deferred with rationale.

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | HIGH | Missing `plugins/claude/LICENSE` / `plugins/gemini/LICENSE` stubs | **FIXED** — added pointer stubs referencing root LICENSE. |
| 2 | HIGH | Missing `docs/m0-smoke.md` | **FIXED** — written with verbatim smoke output. TUI + github probes documented as deferred (human-required / post-push). |
| 3 | HIGH | Linter accepts non-bare plugin names (colons, slashes, uppercase) | **FIXED** — `BARE_NAME` regex `/^[a-z][a-z0-9-]*$/` enforced on marketplace `name`, every plugin `name`, every plugin.json `name`, every command filename stem. |
| 4 | HIGH | Linter ignores `commands/*.md` frontmatter | **FIXED** — `checkCommandsDir` walks both plugins, parses YAML frontmatter, enforces key allowlist `{description, argument-hint, allowed-tools}`, rejects empty body, enforces bare filename stem. |
| 5 | MEDIUM | No self-test fixture codifies "malformed manifest fails lint" | **FIXED** — `scripts/ci/check-manifests-self-test.mjs` drives the linter against 6 negative fixtures (auth-NEVER, colon-name, unknown-frontmatter, colon-filename, bad-capability, non-semver). All reject. CI runs it via `npm run lint:self-test`. |
| 6 | MEDIUM | `.gitignore` line with literal `~` doesn't match anything | **FIXED** — removed. |
| 7 | MEDIUM | CI `pull_request.branches` misuse; `push.branches` missed feat | **FIXED** — `push.branches: [main, "docs/**", "feat/**"]`; `pull_request.branches: [main, "docs/**"]` (correct target-branch filter). |
| 8 | MEDIUM | `node --test 'glob'` does not expand globs; silently passes with zero tests | **FIXED** — switched to directory-recursion `node --test tests/unit/`. |
| 9 | MEDIUM | `capabilities` enum values speculative | **VERIFIED** — `codex-rs/core-plugins/src/marketplace_tests.rs:1168,1204,1296,1320` confirms `"Interactive"`, `"Read"`, `"Write"` are accepted. Values retained. Linter now enforces the enum. |
| 10 | MEDIUM | Gemini `longDescription` leaks M7-only implementation detail | **FIXED** — trimmed to neutral description. |
| 11 | LOW | README claims github install works before push | **ACCEPTED** — claim is for v0.1.0 posture; current M0 scope explicitly documented in README status section. Live github probe deferred to post-push update of `docs/m0-smoke.md`. |
| 12 | LOW | NOTICE "Anthropic PBC" line is factually wrong for M0 | **FIXED** — removed. Only upstream MIT attribution remains. |
| 13 | LOW | Ping command body instructs model; output is non-deterministic | **ACCEPTED** — acceptable for M0 smoke; command presence + dispatch is the real check, not response content. Will reconsider if TUI smoke shows paraphrase that breaks the "ok" assertion. |
| 14 | LOW | npm workspaces point to plugin dirs without package.json | **FIXED** — added minimal `plugins/claude/package.json` and `plugins/gemini/package.json`. |
| 15 | LOW | plugin.json lacks `commands` declaration | **ACCEPTED** — Codex discovers `commands/*.md` implicitly (per openai/plugins convention; verified via figma/vercel plugins which also omit explicit declaration). Flag re-raised if M1+ schema evolves. |

## Top M1 hazards the reviewer surfaced, now closed

- **(a)** Linter bare-name rule — closed via #3.
- **(b)** Test-file glob silent-skip — closed via #8.
- **(c)** Capabilities enum speculative — closed via #9 (verified against codex-rs source).
