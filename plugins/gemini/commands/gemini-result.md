---
description: Show the persisted result for a Gemini-plugin job.
argument-hint: "<job-id>"
---

## Workflow

Run:
```
node "<plugin-root>/scripts/gemini-companion.mjs" result --job "$ARGUMENTS"
```

Render the returned JobRecord. Do not expose sidecar file paths unless the user asks.

For `staged`, `head`, and `branch-diff` scopes, the scoped tree is a git
object-pure snapshot: checkout filters, LFS smudge, EOL conversion, textconv,
hooks, and config-defined shell commands are not applied, and replace refs and
grafts are ignored. `working-tree` reflects live filesystem content for
**tracked + untracked-non-ignored** files only — gitignored files (e.g. `.env`)
are excluded by default to avoid exposing secrets to the target model. Use
`custom` with explicit globs when a caller deliberately needs to include
ignored files.

**Privacy contract scope.** The gitignored-file filter only applies when the
source directory is inside a git worktree. In a non-git folder, `working-tree`
runs an unfiltered live filesystem walk with symlink/path safety only — there
is no `.gitignore` to consult, so secrets in `.env`-style files in non-git
directories will be visible to the target model unless the caller switches to
`custom` with a curated glob list. Transient `git ls-files` failures inside a
worktree retry briefly before the run fails closed.
