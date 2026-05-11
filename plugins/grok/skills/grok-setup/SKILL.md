---
name: grok-setup
description: Use when checking Grok Web local tunnel readiness.
user-invocable: true
---

# Grok Setup

Use the Grok Web setup workflow. Current Codex builds expose it as
`grok:grok-setup` in the skill picker; its skill frontmatter name is
`grok-setup`; the command contract is `plugins/grok/commands/grok-setup.md`.

Run from the repository root:

```bash
node plugins/grok/scripts/grok-web-reviewer.mjs doctor
```

Show `summary`, `ready`, `next_action`, and `tunnel_start`. Show credential key names only. Never print session cookies, tunnel API-key values, or bearer token
values. If a loopback grok2api `/v1` endpoint is unavailable, the doctor tries
to use an existing checkout or bootstrap `https://github.com/chenyme/grok2api.git`
into the default runtime directory, then starts it with `uv run granian
--interface asgi --host 127.0.0.1 --port 8000 --workers 1 app.main:app`; Docker
is not required. If bootstrap/start cannot run, report the specific
`tunnel_start.error_code` and do not suggest direct xAI API keys. Do not import
browser cookies unless the user explicitly requests that session sync step.
