---
description: Ask DeepSeek direct API to review explicit files.
argument-hint: "--scope-paths <files> [review prompt]"
---

Run:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider deepseek --mode custom-review --scope custom --scope-paths "<file1>,<file2>" --prompt "<prompt text>"
```

`$ARGUMENTS` may include `--scope-paths <files>` followed by prompt text. Pass the files to `--scope-paths`. Replace `<file1>,<file2>` with comma- or newline-separated concrete relative paths, expand globs before running, and pass only the remaining prompt text to `--prompt`.
Render the returned JobRecord. If `external_review` is present, render it before the review result. Do not print API-key values.
