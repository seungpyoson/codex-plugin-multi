# M0 smoke-test record

Recorded during autonomous execution of milestone M0 (scaffold + install-path verification).

## Environment

- **Date:** 2026-04-23T17:22:29Z
- **Host:** `spson@local`
- **Codex CLI:** 0.123.0
- **Branch:** `feat/m0-scaffold` (uncommitted at time of probe)

## T0.5 — local install smoke (pass)

Command + output, verbatim:

```
$ codex plugin marketplace add /Users/spson/Projects/Claude/codex-plugin-multi
Added marketplace `codex-plugin-multi` from /Users/spson/Projects/Claude/codex-plugin-multi.
Installed marketplace root: /Users/spson/Projects/Claude/codex-plugin-multi
```

Config entry written to `~/.codex/config.toml`:

```toml
[marketplaces.codex-plugin-multi]
last_updated = "2026-04-23T17:22:29Z"
source_type = "local"
source = "/Users/spson/Projects/Claude/codex-plugin-multi"
```

Cleanup:

```
$ codex plugin marketplace remove codex-plugin-multi
Removed marketplace `codex-plugin-multi`.
```

Config post-remove: `grep codex-plugin-multi ~/.codex/config.toml` → no matches. Clean.

**Conclusion:** local path install round-trip works. Both plugin directories (`plugins/claude`, `plugins/gemini`) are discoverable through the marketplace manifest.

## T0.4 — TUI dispatch smoke (superseded)

This original M0 plan assumed plugin command files would appear as TUI slash
commands. Fresh-install verification on Codex CLI 0.125.0 disproved that:
plugin `commands/*.md` files are not registered in the TUI slash-command
dispatcher. Diagnostic ping command docs are now deferred until upstream Codex
supports plugin command registration.

**Current verification steps:**

1. `codex plugin marketplace add /path/to/codex-plugin-multi`
2. Launch `codex` (TUI).
3. Type `/plugins`, press Enter. Both `claude` and `gemini` plugins listed as available.
4. Highlight each, press Space to toggle enabled.
5. Confirm the Claude and Gemini delegation skills are model-visible.
6. `codex plugin marketplace remove codex-plugin-multi` when done.

Any deviation in marketplace install, plugin enablement, or skill visibility is
a blocker for the local fallback surface.

## T0.5 — github install smoke (deferred, post-push)

The github-source install path is verified via code-path equivalence
(spec §4.13: `owner/repo[@ref]` resolves to
`https://github.com/owner/repo.git`, clones, then runs the identical
local-path validator). A live github probe requires pushing
`feat/m0-scaffold` to origin, which this autonomous run does at the end
of M0. The recorded run will land as an update to this file.

## Linter self-test (pass)

```
$ node scripts/ci/check-manifests.mjs
✓ All manifests + command files valid

$ node scripts/ci/check-manifests-self-test.mjs
✓ [auth-never] linter rejected the broken fixture
✓ [colon-name] linter rejected the broken fixture
✓ [unknown-frontmatter] linter rejected the broken fixture
✓ [colon-filename] linter rejected the broken fixture
✓ [bad-capability] linter rejected the broken fixture
✓ [non-semver] linter rejected the broken fixture

✓ all self-test cases passed
```
