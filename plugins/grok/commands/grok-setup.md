---
description: Check Grok subscription-backed local tunnel configuration.
argument-hint: ""
---

Run:

```bash
node plugins/grok/scripts/grok-web-reviewer.mjs doctor
```

Render the returned JSON. Show key names only. Do not print session cookies,
tunnel API keys, or bearer token values.

This command performs a live `GET /models` probe against the configured local
tunnel. Treat `ready: true` and `reachable: true` as evidence that the
subscription-backed tunnel is reachable. If it returns `tunnel_unavailable`,
tell the user to start the local Grok web tunnel and retry rather than adding
direct xAI API keys. Docker is optional for grok2api; the local path is
`cd $GROK2API_HOME && uv sync && uv run granian --interface asgi --host
127.0.0.1 --port 8000 --workers 1 app.main:app`.
