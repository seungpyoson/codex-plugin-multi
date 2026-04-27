# Upstream provenance — plugins/claude/scripts/lib/

All files in this directory are ported from
[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) (MIT license)
into this repository (Apache-2.0). Per the MIT text, the upstream copyright notice
is preserved in the repository's top-level `NOTICE` file. Per the Apache License,
each modified file carries a "modified from upstream" comment header indicating
the source path and synced commit.

**Synced commit:** `807e03ac9d5aa23bc395fdec8c3767500a86b3cf` (2026-04-18, "fix: bump plugin version to 1.0.4 (#244)")

**Upstream path:** `plugins/codex/scripts/lib/` in the referenced SHA above.

## Port classification

Four files are copied verbatim (target-neutral; no Codex-specific references):

| File | Upstream role |
|---|---|
| `workspace.mjs` | Resolves workspace root via git. |
| `process.mjs`   | Generic child-process helpers (spawn, timeout, SIGTERM→SIGKILL). |
| `args.mjs`      | Argument parsing / mutex enforcement. |
| `git.mjs`       | Git helpers (status, branch, worktree). |

Removed in T7.5 (§21.5 "zero importers → deleted"):

- `job-control.mjs` — imported `./codex.mjs` which does not exist in this port;
  had no production consumer. Byte-identity gave a false positive here
  (both copies equally broken); the new `lib-imports.test.mjs` catches it.
- `prompts.mjs` — prompt-template loader with no production caller in either
  plugin. Reintroduce only when a live importer lands.
- `render.mjs` — Claude/Gemini display-string renderer; commands now render
  directly in the model rather than delegating to a library function, so the
  module had no production importer.
- `tracked-jobs.mjs` — job-log/progress helpers with no production caller in
  either companion. Job records are written directly by the live entry points.

One file is parametrized at module init to remove hardcoded Codex strings
(see file-level comment headers). We use a module-level mutable `CONFIG` with
a `configure*()` setter rather than the factory pattern in spec §6.2 —
factories would force rewriting every upstream import site, so we keep the
named-export API and set config once at companion startup.

| File | Parametrization | Setter |
|---|---|---|
| `state.mjs`        | `pluginDataEnv`, `fallbackStateRootDir`, `sessionIdEnv` | `configureState({...})` |

Dropped from the port (no analog in v1):

- `app-server.mjs`, `app-server-protocol.d.ts`, `broker-*.mjs` — Codex ACP
  transport has no Claude/Gemini equivalent in v1.
- `codex.mjs` — replaced by per-plugin `lib/claude.mjs` / `lib/gemini.mjs`
  (lands in M2 / M7).
- `render.mjs`, `job-control.mjs`, `prompts.mjs`, `tracked-jobs.mjs`, `fs.mjs` — see "Removed in T7.5"
  section above.

## Re-sync procedure

When upstream releases a new version:

1. Update the "Synced commit" line above.
2. For each verbatim file, diff against upstream and re-copy if changed. Any new
   Codex-specific string triggers a promotion to the "parametrized" list.
3. For each parametrized file, re-apply the parametrization delta manually; each
   file's header includes the exact transformation so the delta is obvious.
4. Re-run `npm test` + CI.
