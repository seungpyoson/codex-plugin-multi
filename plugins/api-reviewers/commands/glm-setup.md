---
description: Check GLM direct API reviewer readiness.
---

Run:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs doctor --provider glm
```

Show the returned `summary`. If `ready` is false, show `next_action` exactly.
