---
description: Ask GLM direct API to review explicit files.
argument-hint: "--scope-paths <files> [review prompt]"
---

Run:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider glm --mode custom-review --scope custom --scope-paths "<file1>,<file2>" --lifecycle-events jsonl --prompt "<prompt text>"
```

`$ARGUMENTS` may include `--scope-paths <files>` followed by prompt text. Pass the files to `--scope-paths`. Replace `<file1>,<file2>` with comma- or newline-separated concrete relative paths, expand globs before running, and pass only the remaining prompt text to `--prompt`.
The review timeout default is 600000 ms; `API_REVIEWERS_TIMEOUT_MS` is the non-interactive fallback.
Render the returned JobRecord. Render `external_review_launched` as soon as it appears. If `external_review` is present, render it before the review result. If the JobRecord failed, report `error_code`, `error_message`, `http_status` when present, and `suggested_action`. Do not print API-key values.
