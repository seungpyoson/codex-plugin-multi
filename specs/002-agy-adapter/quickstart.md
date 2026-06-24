# Quickstart: Relay AGY Adapter

## Source-Free AGY Probes

These commands do not send repository source.

```bash
agy models
agy --print-timeout 20s --print "Reply with exactly: relay-agy-probe"
```

Expected local result observed on 2026-06-09:

- `agy models` printed model choices.
- `agy --print-timeout 20s --print ...` printed `relay-agy-probe`.

## Verification Commands

Use focused `node --test` commands for AGY-specific checks; the repository `npm test -- ...` wrapper can expand into a broader pre-commit suite.

```bash
node --test tests/unit/agy-dispatcher.test.mjs tests/smoke/agy-companion.smoke.test.mjs
node --test tests/unit/job-record.test.mjs tests/unit/external-model-contracts.test.mjs tests/unit/provider-readiness-manifest.test.mjs tests/unit/docs-contracts.test.mjs tests/unit/companion-source-hygiene.test.mjs tests/smoke/agy-companion.smoke.test.mjs
node --test tests/unit/external-model-contracts.test.mjs tests/unit/relay-build-contracts.test.mjs tests/unit/manifests.test.mjs tests/unit/plugin-copies-in-sync.test.mjs
npm run build:relay
npm run build:codex-relay
npm run lint:sync
npm test
```

The mocked AGY smoke tests cover source-bearing review paths without sending repository source to live AGY. No source-bearing live AGY test is required for this feature; do not run live source-bearing AGY prompts unless a future task explicitly adds an approval gate and records the source-send evidence.

`npm run build:codex-relay` is included as a regression check for direct API split packages. The AGY Codex package is expected to be validated through generated contracts, manifest tests, and sync tests unless implementation explicitly expands Codex build generation.

## Manual Generated Artifact Checks

After build commands:

```bash
test -f plugins/agy/commands/agy-review.md
test -f relay/relay-agy/commands/review.md
rg -n "relay-agy|AGY|Antigravity" .claude-plugin/marketplace.json plugins/agy relay/relay-agy
```

## Safety Checks

```bash
rg -n "approval_token|cookie|bearer|API_KEY|source bundle" plugins/agy relay/relay-agy specs/002-agy-adapter
rg -n "Codex sandbox|Claude Code session" plugins/agy/commands plugins/agy/skills
```

The first search must not reveal secret values. The second search should only find host-specific text if it is intentionally produced by a host renderer, not canonical AGY docs.

## Final Notes

Implemented scope:
- AGY is a Relay companion-style reviewer provider for the existing Codex and Claude Code Relay surfaces.
- AGY source-bearing behavior is covered by mocked smoke tests, JobRecord/source-redaction tests, readiness manifest tests, and generated docs contracts.
- Source-free AGY readiness was verified with `agy models` and the `relay-agy-probe` print command.

Remaining gaps and non-goals:
- Native Antigravity host packaging is not shipped. It remains deferred until `agy plugin validate` and install/import semantics are tested against a generated native artifact.
- No live source-bearing AGY review was run for this feature. Future live source-bearing AGY tests need an explicit approval gate and recorded source-send evidence.
- AGY coverage baseline entries were added as zero-floor inventory entries for the new provider library files; future coverage work should raise those floors once AGY-specific coverage stabilizes.
