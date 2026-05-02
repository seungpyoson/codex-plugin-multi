import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveProfile } from "../../plugins/kimi/scripts/lib/mode-profiles.mjs";
import { buildKimiArgs, parseKimiResult } from "../../plugins/kimi/scripts/lib/kimi.mjs";

const KIMI_SESSION_ID = "22222222-3333-4444-9555-666666666666";

test("parseKimiResult: classifies raw max-step exhaustion before JSON parsing", () => {
  const parsed = parseKimiResult(
    "Max number of steps reached: 1\n",
    `To resume this session: kimi -r ${KIMI_SESSION_ID}\n`,
  );

  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "step_limit_exceeded");
  assert.equal(parsed.error, "Max number of steps reached: 1");
  assert.equal(parsed.stepLimit, 1);
  assert.equal(parsed.sessionId, KIMI_SESSION_ID);
  assert.equal(parsed.raw, "Max number of steps reached: 1\n");
});

test("buildKimiArgs: review modes use safer max-step defaults and allow overrides", () => {
  const reviewArgs = buildKimiArgs(resolveProfile("review"), {
    model: "kimi-k2-turbo-preview",
    includeDirPath: "/tmp/scoped-worktree",
  });
  assert.equal(reviewArgs[reviewArgs.indexOf("--max-steps-per-turn") + 1], "16");

  const adversarialArgs = buildKimiArgs(resolveProfile("adversarial-review"), {
    model: "kimi-k2-turbo-preview",
    includeDirPath: "/tmp/scoped-worktree",
  });
  assert.equal(adversarialArgs[adversarialArgs.indexOf("--max-steps-per-turn") + 1], "32");

  const customOverrideArgs = buildKimiArgs(resolveProfile("custom-review"), {
    model: "kimi-k2-turbo-preview",
    includeDirPath: "/tmp/scoped-worktree",
    maxStepsPerTurn: 48,
  });
  assert.equal(customOverrideArgs[customOverrideArgs.indexOf("--max-steps-per-turn") + 1], "48");
});
