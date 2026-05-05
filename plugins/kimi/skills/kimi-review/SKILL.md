---
name: kimi-review
description: Use when asking Kimi Code CLI to review the current diff, files, or focus area.
user-invocable: true
---

# Kimi Review

Use the Kimi companion review workflow. Current Codex builds expose it as `kimi:kimi-review` in the skill picker; its skill frontmatter name is `kimi-review`; the command contract is `plugins/kimi/commands/kimi-review.md`.

`<plugin-root>` is `plugins/kimi` or an absolute path to that plugin directory; `<workspace>` is the repository or bundle directory to review; `<focus>` is the user's review prompt or focus area. Run:

```bash
node "<plugin-root>/scripts/kimi-companion.mjs" run --mode=review --foreground --lifecycle-events jsonl --cwd "<workspace>" -- "<focus>"
```

If the user provides them, add `--scope-base REF`, `--timeout-ms MS`, and/or
`--max-steps-per-turn N` before `--`; `N` must be a positive integer.
The review timeout default is 600000 ms; `KIMI_REVIEW_TIMEOUT_MS` is the non-interactive fallback.

Render the returned JobRecord, render `external_review_launched` as soon as it appears, then render `external_review` before normal prose when present, and surface `mutations`. Do not claim `/kimi-review` is available in Codex builds that do not register plugin command files.
