---
description: Check DeepSeek direct API reviewer readiness.
---

Run:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs doctor --provider deepseek
```

Show the returned `summary`. If `ready` is false, show `next_action` exactly.
The doctor performs a source-free live provider probe; do not print API-key
values or provider response payloads.
