# Research: Relay AGY Adapter

## Decision: Scope AGY As A Relay Provider First

**Decision**: Implement AGY as a new Relay external-model provider exposed through the existing Codex and Claude Code Relay packages. Keep full Antigravity host-plugin packaging as a follow-up unless its plugin schema is verified during implementation.

**Rationale**: Relay's current product model is provider plugins that Codex can install from `plugins/*` and Claude Code can install from generated `relay/relay-*` packages. The user asked for an AGY adapter for Relay and specifically called out Claude Code and Codex plugin agnosticism. The minimum coherent interpretation is a provider adapter that both existing host surfaces can consume. AGY also has `plugin import/install/validate`, but that is a host packaging surface and should not block the reviewer-provider MVP.

**Alternatives considered**:
- Add only an Antigravity host marketplace adapter. Rejected for MVP because it would not add AGY as a reviewer target for current Relay users.
- Reuse the Claude or Gemini package as AGY. Rejected because AGY has a different binary, flags, model list, and output shape.
- Add Codex-only AGY support first. Rejected because it violates the explicit host-agnostic requirement.

## Decision: Treat AGY As A Companion-Style CLI Provider

**Decision**: Build AGY near the Claude/Gemini/Kimi companion architecture rather than the DeepSeek/GLM direct API architecture.

**Rationale**: Local source-free probes on 2026-06-09 confirmed:
- `command -v agy` resolves to `/Users/spson/.local/bin/agy`.
- `agy --help` exposes `--print`, `--print-timeout`, `--model`, `--sandbox`, `--continue`, `--conversation`, and plugin management subcommands.
- `agy models` succeeds and lists subscription models including Gemini, Claude, and GPT-OSS families.
- `agy --print-timeout 20s --print "Reply with exactly: relay-agy-probe"` returns `relay-agy-probe`.

This looks like a local subscription/OAuth-style CLI that can accept a prompt and produce text. It does not look like Relay's direct API approval-token flow.

**Alternatives considered**:
- Model AGY as a direct API provider. Rejected because no API key route is evident from the local CLI facts.
- Route AGY through Gemini's companion adapter. Rejected because AGY output is plain text in the verified source-free probe, while Gemini companion expects Gemini CLI JSON.

## Decision: Extract Shared Provider And Host Packaging Metadata

**Decision**: Introduce a shared provider/build metadata helper, likely in `scripts/lib/plugin-targets.mjs` or a new `scripts/lib/provider-plugin-definitions.mjs`, and make `relay-build.mjs`, `external-model-contracts.mjs`, sync tests, and any relevant Codex package validation consume it. Keep `codex-relay-build.mjs` direct-API-only unless implementation explicitly expands its scope with failing tests first.

**Rationale**: Current provider registration is split:
- `scripts/lib/external-model-contracts.mjs` has `COMPANION_PROVIDERS`, `API_PROVIDERS`, and `GROK_PROVIDER`.
- `scripts/lib/relay-build.mjs` has `RELAY_PROVIDER_ORDER` and `RELAY_PROVIDER_DEFINITIONS`.
- `scripts/lib/codex-relay-build.mjs` has `DIRECT_API_PROVIDERS` and only generates split direct API packages today.
- `scripts/lib/plugin-targets.mjs` has shared target sets for sync tests but not full provider metadata.

Adding AGY by appending hard-coded lists would work locally but would not be agnostic to Codex and Claude Code plugin surfaces. Shared metadata should own provider identity, family, command prefix, source package, binary name, runtime data env, session id env, generated workflows, manifest facts, and Claude rewrite flags.

**Alternatives considered**:
- Patch each list independently. Rejected due to drift risk and explicit user requirement.
- Generate every provider from package manifests only. Deferred because existing generated docs need richer facts than manifests currently hold.

## Decision: Use TDD Across Runtime, Generation, And Sync

**Decision**: Implementation must start with failing tests for AGY dispatcher behavior, generated contracts, Codex build output, Claude build output, and sync target inclusion.

**Rationale**: The requested sequence explicitly requires TDD after a clear task list. The most likely regressions are generation drift and mistaken provider family routing, so tests should fail before production changes in these areas:
- `tests/unit/agy-dispatcher.test.mjs` for AGY args, parsing, timeout, and source-free readiness behavior.
- `tests/smoke/agy-companion.smoke.test.mjs` for mocked lifecycle/JobRecord behavior.
- `tests/unit/external-model-contracts.test.mjs` for generated docs and target count/path coverage.
- `tests/unit/relay-build-contracts.test.mjs` for `relay/relay-agy` and `.claude-plugin/marketplace.json`.
- `tests/unit/codex-relay-build-contracts.test.mjs`, manifest tests, or a new host-build test for Codex AGY package facts, depending on whether Codex companion package generation remains canonical-source-based or becomes build-generated.
- `tests/unit/plugin-copies-in-sync.test.mjs` for shared library and target-set inclusion.

**Alternatives considered**:
- Clone Gemini implementation and add tests later. Rejected because the TDD gate forbids production code before failing tests.

## Decision: Keep AGY Safety Host-Neutral

**Decision**: Docs and runtime diagnostics should say "current execution environment" or "local execution" where possible, and host-specific text should be rendered by host adapters only.

**Rationale**: Existing `renderClaudeCommandDoc` rewrites Codex-specific sandbox language to Claude Code language. AGY should not add more host-specific wording to canonical provider contracts. The shared helper should carry host-neutral semantics, while Codex and Claude build renderers adapt only the shell mechanics and host environment names.

**Alternatives considered**:
- Let canonical AGY docs be Codex-specific and rewrite them for Claude. Rejected because the user explicitly asked for a helper agnostic to both.

## Decision: Do Not Claim Stable Antigravity Host Packaging Yet

**Decision**: Record Antigravity plugin management as verified surface area but defer a production AGY host package until schema and install semantics are tested.

**Rationale**: `agy plugin --help` confirms commands for `list`, `import`, `install`, `uninstall`, `enable`, `disable`, `validate`, and `link`. It also says import supports `gemini` or `claude`. That is enough to shape shared helper boundaries, but not enough to claim Relay can ship a native AGY host marketplace package.

**Alternatives considered**:
- Include AGY host packaging in MVP. Rejected until `agy plugin validate` is tested against generated artifacts and the expected marketplace schema is documented.

## Verified AGY Facts

As of 2026-06-09, the verified AGY facts are source-free local CLI probes only:

- `command -v agy` resolves to `/Users/spson/.local/bin/agy`.
- `agy --help` exposes `--print`, `--print-timeout`, `--model`, `--sandbox`, `--continue`, `--conversation`, and plugin management subcommands.
- `agy models` succeeds and lists subscription-backed model choices, including Gemini, Claude, and GPT-OSS families.
- `agy --print-timeout 20s --print "Reply with exactly: relay-agy-probe"` returns `relay-agy-probe`.

These facts justify treating AGY as a companion-style local CLI provider. They do not prove live source-bearing review behavior. Source-bearing behavior in this implementation is covered by mocked AGY smoke tests, shared JobRecord/source-redaction tests, and generated contract tests.

## Deferred AGY Host Packaging Boundaries

Native Antigravity host package support is deferred and not shipped in this feature.

The implemented package is a Relay provider package exposed through the existing Codex and Claude Code Relay surfaces. A native Antigravity host package remains follow-up work until:

- `agy plugin validate` is tested against a generated native artifact.
- Antigravity host install/import semantics are documented for the artifact shape Relay will produce.
- The native package can be verified without weakening the current review-only source-send and JobRecord contracts.

## External References

- Google Antigravity CLI repository: https://github.com/google-antigravity/antigravity-cli
- Google Antigravity CLI overview: https://antigravity.google/docs/cli-overview
- Spec Kit Antigravity integration mention: https://github.com/github/spec-kit/releases

## Open Implementation Checks

- Confirm whether `agy --sandbox` is sufficient and appropriate for review-only source-bearing prompts.
- Confirm whether `agy --print` supports structured or machine-readable output. If not, parse plain stdout and keep JobRecord normalization in shared code.
- Confirm whether `agy --conversation` or `--continue` can safely support Relay continuation without resending source.
- Confirm whether `agy plugin validate` accepts generated Claude plugin packages, a native AGY package, or both.

## TDD Evidence: Shared Provider Metadata Red

**Date**: 2026-06-09

Attempted the task-listed `npm test -- tests/unit/provider-plugin-definitions.test.mjs tests/unit/external-model-contracts.test.mjs tests/unit/relay-build-contracts.test.mjs tests/unit/codex-relay-build-contracts.test.mjs`; the repo harness expanded into unrelated broader tests and was stopped after confirming it was not a useful focused red run.

Focused command:

```sh
node --test tests/unit/provider-plugin-definitions.test.mjs tests/unit/external-model-contracts.test.mjs tests/unit/relay-build-contracts.test.mjs tests/unit/codex-relay-build-contracts.test.mjs
```

Expected red result: 44 passed, 5 failed.

Expected failures:
- `AGY Codex metadata uses canonical plugins/agy and stays outside direct API generation`: missing `scripts/lib/provider-plugin-definitions.mjs`.
- `external model contract targets include AGY paths from shared provider metadata`: AGY generated target paths absent.
- `shared provider metadata defines AGY as a companion provider for both host packages`: missing shared provider metadata helper.
- `shared provider metadata keeps provider ids, command prefixes, and package targets unique`: missing shared provider metadata helper.
- `buildRelayPlugin: emits relay-agy Claude plugin tree from shared provider metadata`: `unsupported relay provider: agy`.

## TDD Evidence: Shared Provider Metadata Green

**Date**: 2026-06-09

Command:

```sh
node --test tests/unit/provider-plugin-definitions.test.mjs tests/unit/external-model-contracts.test.mjs tests/unit/relay-build-contracts.test.mjs tests/unit/codex-relay-build-contracts.test.mjs
```

Result: 49 passed, 0 failed.

Green evidence:
- `scripts/lib/provider-plugin-definitions.mjs` defines AGY once as a companion provider with Codex package directory `agy` and Claude package directory `relay-agy`.
- `scripts/lib/plugin-targets.mjs`, `scripts/lib/external-model-contracts.mjs`, `scripts/lib/relay-build.mjs`, and `scripts/lib/codex-relay-build.mjs` consume shared provider metadata.
- `EXTERNAL_MODEL_CONTRACT_DOC_TARGETS` includes generated AGY command and skill paths.
- `buildRelayPlugin({ provider: "agy" })` emits `relay-agy` from shared provider facts.
- `buildCodexDirectApiPlugin({ provider: "agy" })` still fails closed because AGY is not a direct API split package.

## TDD Evidence: AGY Runtime Red

**Date**: 2026-06-09

Command:

```sh
node --test tests/unit/agy-dispatcher.test.mjs tests/smoke/agy-companion.smoke.test.mjs
```

Expected red result: 0 passed, 8 failed.

Expected failures:
- AGY smoke doctor/review/adversarial-review tests fail because `plugins/agy/scripts/agy-companion.mjs` does not exist.
- AGY dispatcher tests fail because `plugins/agy/scripts/lib/agy.mjs` does not exist.

## TDD Evidence: AGY Runtime Green

**Date**: 2026-06-09

Task-listed command:

```sh
npm test -- tests/unit/agy-dispatcher.test.mjs tests/smoke/agy-companion.smoke.test.mjs
```

Observed result: exit 1 because the repository test wrapper expanded into a broad pre-commit suite instead of limiting execution to the two requested AGY files. The AGY doctor/review/adversarial-review smoke tests and AGY dispatcher tests passed inside that wrapper, but unrelated next-phase package-copy checks failed because `plugins/agy/scripts/lib/*` shared-library copies are not complete yet.

Focused command used for the US1 runtime checkpoint:

```sh
node --test tests/unit/agy-dispatcher.test.mjs tests/smoke/agy-companion.smoke.test.mjs
```

Result: 8 passed, 0 failed.

Green evidence:
- AGY source-free doctor uses a mocked binary and reports readiness without source transmission.
- AGY review and adversarial-review foreground lifecycle jsonl emit review-only terminal JobRecords with `target: "agy"`.
- `buildAgyArgs` covers print mode, timeout, sandbox, model, `--add-dir`, and conversation id behavior.
- `parseAgyResult` accepts plain stdout review text and classifies empty output, auth failure, usage limits, and timeout.
- `spawnAgy` delivers prompts through `--print`, sanitizes target env, captures pid info, and treats timeouts as terminal without automatic retry.

## TDD Evidence: AGY Package/Docs Red

**Date**: 2026-06-09

Focused command used instead of the broad `npm test -- ...` wrapper:

```sh
node --test tests/unit/external-model-contracts.test.mjs tests/unit/relay-build-contracts.test.mjs tests/unit/manifests.test.mjs tests/unit/plugin-copies-in-sync.test.mjs
```

Expected red result: 103 passed, 27 failed.

Expected failures:
- `agy plugin metadata is registered in the Codex marketplace`: `relay-agy` missing from `.agents/plugins/marketplace.json`.
- AGY shared-library package-copy assertions fail because `plugins/agy/scripts/lib/*` does not yet contain the canonical companion shared libraries, including `companion-common.mjs`, `external-review.mjs`, `external-model-failure-*`, `external-model-review-quality.mjs`, `privacy-redaction.mjs`, `provider-route-policy.mjs`, `codex-env.mjs`, `workspace.mjs`, `process.mjs`, `args.mjs`, `git.mjs`, `git-binary.mjs`, `scope.mjs`, `cancel-marker.mjs`, `time.mjs`, and `diff-source.mjs`.

Passing checks in the same red run:
- Generated AGY command and skill contract paths are present and drift-checked from shared source.
- AGY generated docs contain the shared review-only, lifecycle, scope safety, secret safety, setup, and source-send safety clauses.
- `buildRelayPlugin({ provider: "agy" })` emits `relay-agy`; `buildRelaySuite` includes `relay-agy` in the Claude relay package set.

## TDD Evidence: AGY Package/Docs Green

**Date**: 2026-06-09

Build commands:

```sh
npm run build:relay
npm run build:codex-relay
```

Build evidence:
- `npm run build:relay` emitted `relay/relay-agy`.
- `.claude-plugin/marketplace.json` includes `relay-agy` with source `./relay/relay-agy`.
- `npm run build:codex-relay` emitted only `plugins/relay-deepseek` and `plugins/relay-glm`; `plugins/relay-agy` does not exist.

Focused command:

```sh
node --test tests/unit/external-model-contracts.test.mjs tests/unit/relay-build-contracts.test.mjs tests/unit/manifests.test.mjs tests/unit/plugin-copies-in-sync.test.mjs
```

Result: 130 passed, 0 failed.

Green evidence:
- AGY command and skill docs are generated and drift-checked from `scripts/lib/external-model-contracts.mjs`.
- `relay-agy` is registered in the Codex marketplace metadata and root workspace list.
- AGY shared runtime copies match canonical shared files or the established companion byte-identical set.
- Claude relay build tests prove `relay/relay-agy/commands/review.md` routes through `agy-companion.mjs` and keeps host-neutral prompt transport.

## TDD Evidence: AGY Safety/Parity Red

**Date**: 2026-06-09

Focused command used instead of the broad `npm test -- ...` wrapper:

```sh
node --test tests/unit/job-record.test.mjs tests/unit/external-model-contracts.test.mjs tests/unit/provider-readiness-manifest.test.mjs tests/unit/docs-contracts.test.mjs tests/unit/companion-source-hygiene.test.mjs tests/smoke/agy-companion.smoke.test.mjs
```

Expected red result: 76 passed, 10 failed.

Expected failures:
- `tests/unit/job-record.test.mjs` fails to import `plugins/agy/scripts/lib/job-record.mjs`; AGY has no shared JobRecord builder or `agy_session_id` schema surface yet.
- `provider readiness manifest normalizes seven provider evidence rows`: manifest still emits six providers and ignores AGY evidence.
- `provider-neutral contracts expose the shared audit and status field inventory`: generated contracts do not document `agy_session_id` yet.
- `AGY reviewer docs avoid direct API approval-token and route wording`: AGY docs still expose direct-route placeholders such as `selected_route`.
- `agy companion uses prompt sidecars, source hashes, and no raw-source diagnostics`: AGY companion still constructs prompts inline and persists `sha256` instead of the shared `content_hash` selected-source shape.
- AGY smoke failures cover missing binary diagnostics (`error` not `error_code`), auth failure classification/transmission, timeout retry metadata, missing cancel JSON contract, and accepting non-review stdout as a completed review.

## TDD Evidence: AGY Safety/Parity Green

**Date**: 2026-06-09

Focused command used instead of the broad `npm test -- ...` wrapper:

```sh
node --test tests/unit/job-record.test.mjs tests/unit/external-model-contracts.test.mjs tests/unit/provider-readiness-manifest.test.mjs tests/unit/docs-contracts.test.mjs tests/unit/companion-source-hygiene.test.mjs tests/smoke/agy-companion.smoke.test.mjs
```

Result: 201 passed, 0 failed.

Additional focused smoke command:

```sh
node --test tests/smoke/agy-companion.smoke.test.mjs
```

Result: 8 passed, 0 failed.

Green evidence:
- JobRecord schema and generated result-handling docs include optional `agy_session_id`.
- Provider readiness manifest normalizes seven provider evidence rows, including AGY doctor/review evidence.
- AGY generated docs avoid direct API approval-token and route wording.
- AGY companion uses prompt sidecars, selected-source `content_hash` audit entries, and fail-closed source redaction.
- AGY smoke coverage verifies missing binary, auth failure before source transmission, timeout without automatic retry, foreground cancel JSON, and non-review stdout rejection.

## TDD Evidence: AGY Documentation Boundaries Red

**Date**: 2026-06-09

Focused command used instead of the broad `npm test -- ...` wrapper:

```sh
node --test tests/unit/docs-contracts.test.mjs
```

Expected red result: 41 passed, 2 failed.

Expected failures:
- `AGY spec docs record verified facts and deferred host packaging boundaries`: research notes lacked explicit `## Verified AGY Facts` and deferred native Antigravity host packaging boundary sections.
- `AGY quickstart keeps source-free probes separate from mocked source-bearing tests`: quickstart still used broad `npm test -- ...` examples and did not state that mocked AGY smoke tests cover source-bearing paths without requiring live source-bearing AGY prompts.

## TDD Evidence: AGY Documentation Boundaries Green

**Date**: 2026-06-09

Focused command:

```sh
node --test tests/unit/docs-contracts.test.mjs
```

Result: 43 passed, 0 failed.

Green evidence:
- Research records verified source-free AGY facts and native Antigravity host packaging as deferred follow-up.
- Quickstart separates source-free AGY probes from mocked source-bearing smoke tests and forbids live source-bearing AGY prompts unless a future approval-gated task adds them.
- External review notes include internal, Gemini, Grok, and GLM approval status.

## Final Verification Evidence

**Date**: 2026-06-09

Source-free AGY readiness:

```sh
agy models
agy --print-timeout 20s --print "Reply with exactly: relay-agy-probe"
```

Results:
- `agy models` returned Gemini 3.5 Flash, Gemini 3.1 Pro, Claude Sonnet 4.6, Claude Opus 4.6, and GPT-OSS 120B model choices.
- The print probe returned exactly `relay-agy-probe`.
- Neither command included repository source.

Artifact and wording scans:

```sh
rg -n "approval_token|cookie|bearer|API_KEY|source bundle" plugins/agy relay/relay-agy specs/002-agy-adapter
rg -n "Codex sandbox|Claude Code session" plugins/agy/commands plugins/agy/skills
rg -n "Codex sandbox|Claude Code session" scripts/lib/external-model-contracts.mjs relay/relay-agy/commands
```

Results:
- Secret/source-bundle scan found safety wording, redaction helper patterns, and spec/task references only; no secret values or source bundles were present.
- Host wording scan found the expected Codex package source-send guidance in `plugins/agy` and `scripts/lib/external-model-contracts.mjs`, plus the Claude relay setup restart line in `relay/relay-agy/commands/setup.md`.

Build and generated artifact checks:

```sh
npm run build:relay
npm run build:codex-relay
test ! -e plugins/relay-agy
test -f relay/relay-agy/commands/review.md
rg -n "relay-agy" .claude-plugin/marketplace.json .agents/plugins/marketplace.json package.json
```

Results:
- `npm run build:relay` emitted `relay/relay-agy` with the rest of the Claude relay provider suite.
- `npm run build:codex-relay` emitted only `plugins/relay-deepseek` and `plugins/relay-glm`.
- `plugins/relay-agy` does not exist.
- `relay-agy` appears in Codex and Claude marketplace metadata.

Lint and test gates:

```sh
npm run lint:sync
npm run lint
npm test
npm run test:full
```

Results:
- `npm run lint:sync`: passed.
- `npm run lint`: passed.
- `npm test`: 2,528 passed, 0 failed, 12 skipped.
- `npm run test:full`: 2,689 passed, 0 failed, 12 skipped.

The first `npm test` attempt after AGY integration exposed three remaining contract updates: coverage baseline inventory did not include AGY lib files, and public naming tests still expected six relay providers. Those tests were updated, focused coverage/naming tests passed, and the full `npm test` rerun passed.
