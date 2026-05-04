---
name: gemini-rescue
description: Use when delegating investigation or fixes to Gemini CLI.
user-invocable: true
---

# Gemini Rescue

Use the Gemini companion rescue workflow. Current Codex builds expose it as `gemini:gemini-rescue` in the skill picker; its skill frontmatter name is `gemini-rescue`; the command contract is `plugins/gemini/commands/gemini-rescue.md`.

`<plugin-root>` is `plugins/gemini` or an absolute path to that plugin directory; `<workspace>` is the repository where the rescue task should run. Run:

```bash
node "<plugin-root>/scripts/gemini-companion.mjs" run --mode=rescue --background --cwd "<workspace>" -- "<task>"
```

Rescue is write-capable by design. Prefer review skills for read-only critique. Do not claim `/gemini-rescue` is available in Codex builds that do not register plugin command files.
