---
description: Get Claude Code to adversarially challenge the current design. Not a linter — a "why will this break" pass.
argument-hint: "[--scope-base REF] [--timeout-ms MS] [focus area]"
---

Adversarial review via Claude Code. Assumes the author is wrong; looks for failure modes, hidden assumptions, missing edge cases.

## Arguments

`$ARGUMENTS` — optional `--scope-base REF` and `--timeout-ms MS` followed by focus text (e.g., "error handling", "concurrency"). If `--scope-base REF` is present, pass `--scope-base REF` before `--`. If `--timeout-ms MS` is present, pass it before `--`. Pass the remaining focus text after `--`.

## Workflow

1. Consult the `claude-prompting` skill for adversarial prompt framing.
2. Run:
   ```
   node "<plugin-root>/scripts/claude-companion.mjs" run --mode=adversarial-review --foreground --auth-mode subscription --lifecycle-events jsonl -- "<focus text>"
   ```
   (Containment=worktree, scope=branch-diff, dispose=true all come from the profile — spec §21.4.)
   Review timeout defaults to 900000 ms. Use `--timeout-ms <ms>` or `CLAUDE_REVIEW_TIMEOUT_MS`; the effective value is persisted in `review_metadata.audit_manifest.request.timeout_ms`.
   `branch-diff` is object-pure and committed-only: checkout filters, replace
   refs, grafts, and dirty working-tree edits are ignored. If the target
   changes are uncommitted, do not use adversarial branch-diff as the review
   evidence; use `run --mode=review` for working-tree scope or an explicit
   `custom-review` bundle instead.
   For a pinned review bundle, run `preflight` and then use
   `run --mode=custom-review --auth-mode subscription --scope-paths <g1,g2,...>` with
   prompt wording that names relative paths inside the selected bundle scope.
3. If `external_review_launched` appears, render it immediately. If `external_review` is present on the terminal record, render it before the review result.
4. Render findings by severity. Do not downgrade Claude's concerns even if you (Codex) disagree — the job is to surface them.
5. Watch for a non-empty `mutations` list in the result and surface it. If target read permission denials leave no findings, report review blocked / no findings produced.

## Guardrails

- Adversarial mode is read-only (same sandbox layers as `/claude-review`).
- Do not fix issues here — `/claude-adversarial-review` only reviews. Fixing is `/claude-rescue`.
- No style nits. Model prompt is tuned to suppress low-value cleanup feedback.
