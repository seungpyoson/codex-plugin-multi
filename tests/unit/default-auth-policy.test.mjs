import { test } from "node:test";
import assert from "node:assert/strict";

import { findDefaultAuthPolicyViolations } from "../../scripts/ci/check-default-auth-policy.mjs";

test("default auth policy guard detects operator-facing auto auth defaults", () => {
  const violations = findDefaultAuthPolicyViolations([
    {
      path: "plugins/claude/commands/claude-review.md",
      text: "Run `node plugins/claude/scripts/claude-companion.mjs run --auth-mode auto`.",
    },
    {
      path: "plugins/gemini/skills/gemini-review/SKILL.md",
      text: "Run `gemini review --auth-mode=\"auto\"`.",
    },
    {
      path: "README.md",
      text: "Run `claude review --auth-mode 'auto'`.",
    },
    {
      path: "plugins/claude/scripts/claude-companion.mjs",
      text: "const DEFAULT_AUTH_MODE = \"auto\";",
    },
    {
      path: "plugins/gemini/scripts/gemini-companion.mjs",
      text: "const authMode = process.env.GEMINI_AUTH_MODE || \"auto\";",
    },
    {
      path: "plugins/kimi/scripts/kimi-companion.mjs",
      text: "args.push(\"--auth-mode\", \"auto\");",
    },
    {
      path: "plugins/claude/scripts/claude-companion.mjs",
      text: "const DEFAULT_REVIEW_PERMISSION_MODE_LADDER = Object.freeze([\"dontAsk\", \"auto\"]);",
    },
  ]);

  assert.deepEqual(
    violations.map((item) => item.path),
    [
      "plugins/claude/commands/claude-review.md",
      "plugins/gemini/skills/gemini-review/SKILL.md",
      "README.md",
      "plugins/claude/scripts/claude-companion.mjs",
      "plugins/gemini/scripts/gemini-companion.mjs",
      "plugins/kimi/scripts/kimi-companion.mjs",
    ],
  );
});
