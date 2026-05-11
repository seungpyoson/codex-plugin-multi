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
subscription-backed tunnel is reachable. If a loopback grok2api `/v1` endpoint
is unavailable, doctor tries to use an existing checkout or bootstrap
`https://github.com/chenyme/grok2api.git` into the default runtime directory,
then starts it with `uv run granian --interface asgi --host 127.0.0.1 --port
8000 --workers 1 app.main:app`; Docker is not required. If bootstrap/start
cannot run, surface `tunnel_start.error_code` and do not suggest direct xAI API
keys. Do not import browser cookies unless the user explicitly requests that
session sync step.
