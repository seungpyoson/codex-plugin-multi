---
name: kimi-rescue
description: Use when delegating investigation or fixes to Kimi Code CLI.
user-invocable: true
---

# Kimi Rescue

Use the Kimi companion rescue workflow. Current Codex builds expose it as `kimi:kimi-rescue` in the skill picker; its skill frontmatter name is `kimi-rescue`; the command contract is `plugins/kimi/commands/kimi-rescue.md`.

`<plugin-root>` is `plugins/kimi` or an absolute path to that plugin directory; `<workspace>` is the repository where the rescue task should run. Run:

```bash
node "<plugin-root>/scripts/kimi-companion.mjs" run --mode=rescue --background --cwd "<workspace>" -- "<task>"
```

Rescue is write-capable by design. Prefer review skills for read-only critique. Do not claim `/kimi-rescue` is available in Codex builds that do not register plugin command files.
If the user provides a step budget, add `--max-steps-per-turn N` before `--`; `N` must be a positive integer.
