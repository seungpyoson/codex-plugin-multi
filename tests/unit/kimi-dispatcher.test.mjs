import { test } from "node:test";
import assert from "node:assert/strict";

import { buildKimiArgs, parseKimiResult } from "../../plugins/kimi/scripts/lib/kimi.mjs";
import { MODE_PROFILES, resolveProfile } from "../../plugins/kimi/scripts/lib/mode-profiles.mjs";

const KIMI_SESSION_ID = "22222222-3333-4444-9555-666666666666";

test("buildKimiArgs: every Kimi profile enables thinking mode intentionally", () => {
  for (const profile of Object.values(MODE_PROFILES)) {
    const args = buildKimiArgs(profile, {
      model: profile.name === "ping" ? null : "kimi-code/kimi-for-coding",
    });

    assert.ok(args.includes("--thinking"), `${profile.name} must pass --thinking`);
  }
});

test("buildKimiArgs: review keeps model and plan mode with thinking", () => {
  const args = buildKimiArgs(resolveProfile("review"), {
    model: "kimi-code/kimi-for-coding",
  });

  assert.ok(args.includes("--thinking"));
  assert.equal(args[args.indexOf("-m") + 1], "kimi-code/kimi-for-coding");
  assert.ok(args.includes("--plan"));
});

test("buildKimiArgs: ping may use native model while still probing thinking support", () => {
  const args = buildKimiArgs(resolveProfile("ping"));

  assert.ok(args.includes("--thinking"));
  assert.equal(args.includes("-m"), false);
  assert.ok(args.includes("--plan"));
});

test("buildKimiArgs: resume keeps session id with thinking enabled", () => {
  const args = buildKimiArgs(resolveProfile("custom-review"), {
    model: "kimi-code/kimi-for-coding",
    resumeId: "00000000-0000-4000-8000-000000000000",
  });

  assert.ok(args.includes("--thinking"));
  assert.equal(args[args.indexOf("--session") + 1], "00000000-0000-4000-8000-000000000000");
});

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

test("parseKimiResult: does not treat an embedded max-step line as the sole sentinel", () => {
  const parsed = parseKimiResult(
    `{"content":"partial","session_id":"${KIMI_SESSION_ID}"}\nMax number of steps reached: 8\n`,
    "",
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.result, "partial");
  assert.equal(parsed.sessionId, KIMI_SESSION_ID);
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
