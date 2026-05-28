# Quickstart: Grok CLI-Primary Transport Parity

## Planning Gate

Review these artifacts before implementation:

```bash
sed -n '1,220p' specs/159-grok-cli-primary-parity/spec.md
sed -n '1,220p' specs/159-grok-cli-primary-parity/plan.md
sed -n '1,260p' specs/159-grok-cli-primary-parity/tasks.md
sed -n '1,220p' specs/159-grok-cli-primary-parity/evidence-map.md
sed -n '1,220p' specs/159-grok-cli-primary-parity/data-model.md
sed -n '1,220p' specs/159-grok-cli-primary-parity/contracts/grok-transport-adapter.md
```

Implementation starts only after usable approvals from Claude, Gemini, Grok,
GLM, DeepSeek, and Kimi, or explicit operator waivers.

## Focused Verification After Implementation

```bash
npm run smoke:grok
npm run lint:sync
npm test
git diff --check
```

## Behavior Checks

Default transport should stay CLI:

```bash
node plugins/grok/scripts/grok-companion.mjs help
```

Explicit web transport should stay available:

```bash
node plugins/grok/scripts/grok-companion.mjs help --transport web
```

Auto transport should preserve CLI-primary fallback semantics:

```bash
node plugins/grok/scripts/grok-companion.mjs help --transport auto
```

Live doctor commands, when operator credentials and local tunnel are available:

```bash
node plugins/grok/scripts/grok-companion.mjs doctor --transport cli
node plugins/grok/scripts/grok-companion.mjs doctor --transport web
node plugins/grok/scripts/grok-companion.mjs doctor --transport auto
```

Do not run browser/session repair, cache sync, push, merge, or billing/tier
actions as part of this quickstart without separate operator approval.
