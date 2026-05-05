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

test("MODE_PROFILES: every Kimi profile declares a positive max-step budget", () => {
  for (const [name, profile] of Object.entries(MODE_PROFILES)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(profile, "max_steps_per_turn"),
      `${name} must declare max_steps_per_turn`,
    );
    assert.equal(Number.isInteger(profile.max_steps_per_turn), true, `${name} max_steps_per_turn must be an integer`);
    assert.ok(profile.max_steps_per_turn > 0, `${name} max_steps_per_turn must be positive`);
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

test("parseKimiResult: treats sole max-step sentinel as failure regardless of exit-code metadata", () => {
  for (const options of [undefined, { exitCode: null }, { exitCode: 0 }]) {
    const parsed = parseKimiResult(
      "Max number of steps reached: 1\n",
      `To resume this session: kimi -r ${KIMI_SESSION_ID}\n`,
      options,
    );

    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, "step_limit_exceeded");
    assert.equal(parsed.sessionId, KIMI_SESSION_ID);
  }
});

test("parseKimiResult: classifies mixed JSON plus sentinel when Kimi exits nonzero", () => {
  const parsed = parseKimiResult(
    `{"content":"partial","session_id":"${KIMI_SESSION_ID}"}\nMax number of steps reached: 8\n`,
    "",
    { exitCode: 1 },
  );

  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "step_limit_exceeded");
  assert.equal(parsed.error, "Max number of steps reached: 8");
  assert.equal(parsed.stepLimit, 8);
  assert.equal(parsed.sessionId, KIMI_SESSION_ID);
});

test("parseKimiResult: keeps scanning stream-json lines for session id on step limit", () => {
  const parsed = parseKimiResult(
    `{"content":"partial","session_id":"${KIMI_SESSION_ID}"}\n{"stats":{"tokens":{"total":12}}}\nMax number of steps reached: 8\n`,
    "",
    { exitCode: 1 },
  );

  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "step_limit_exceeded");
  assert.equal(parsed.sessionId, KIMI_SESSION_ID);
});

test("parseKimiResult: recovers JSON session id from stderr when no resume hint exists", () => {
  const parsed = parseKimiResult(
    "Max number of steps reached: 8\n",
    `{"content":"partial","session_id":"${KIMI_SESSION_ID}"}\n`,
    { exitCode: 1 },
  );

  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "step_limit_exceeded");
  assert.equal(parsed.sessionId, KIMI_SESSION_ID);
});

test("parseKimiResult: prefers stdout JSON session id over stderr fallback", () => {
  const stderrSessionId = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
  const parsed = parseKimiResult(
    `{"content":"partial","session_id":"${KIMI_SESSION_ID}"}\nMax number of steps reached: 8\n`,
    `{"content":"stderr","session_id":"${stderrSessionId}"}\n`,
    { exitCode: 1 },
  );

  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "step_limit_exceeded");
  assert.equal(parsed.sessionId, KIMI_SESSION_ID);
});

test("parseKimiResult: accepts stdout resume hints after a failed max-step sentinel", () => {
  const parsed = parseKimiResult(
    `Max number of steps reached: 8\nTo resume this session: kimi -r ${KIMI_SESSION_ID}\n`,
    "",
    { exitCode: 1 },
  );

  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "step_limit_exceeded");
  assert.equal(parsed.error, "Max number of steps reached: 8");
  assert.equal(parsed.stepLimit, 8);
  assert.equal(parsed.sessionId, KIMI_SESSION_ID);
});

test("parseKimiResult: preserves embedded max-step text in successful JSON output", () => {
  const parsed = parseKimiResult(
    `{"content":"partial","session_id":"${KIMI_SESSION_ID}"}\nMax number of steps reached: 8\n`,
    "",
    { exitCode: 0 },
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.result, "partial");
  assert.equal(parsed.sessionId, KIMI_SESSION_ID);
});

test("parseKimiResult: preserves successful review text that mentions quota", () => {
  const parsed = parseKimiResult(
    `{"content":"Verdict: PASS. Check quota and billing cycle handling.","session_id":"${KIMI_SESSION_ID}"}\n`,
    "",
    { exitCode: 0 },
  );

  assert.equal(parsed.ok, true);
  assert.match(parsed.result, /quota and billing cycle/);
  assert.equal(parsed.sessionId, KIMI_SESSION_ID);
});

test("parseKimiResult: tolerates null options argument", () => {
  const parsed = parseKimiResult(
    `{"content":"partial","session_id":"${KIMI_SESSION_ID}"}\nMax number of steps reached: 8\n`,
    "",
    null,
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.result, "partial");
  assert.equal(parsed.sessionId, KIMI_SESSION_ID);
});

test("parseKimiResult: classifies plain-text usage limit failures before JSON parsing", () => {
  const parsed = parseKimiResult(
    "Error code: 403\nYou've reached your usage limit for this billing cycle.\n",
    "",
    { exitCode: 1 },
  );

  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "usage_limited");
  assert.match(parsed.error, /usage limit/i);
  assert.doesNotMatch(parsed.error, /not valid JSON|Unexpected token/);
});

test("parseKimiResult: classifies stderr-only usage limit failures", () => {
  const parsed = parseKimiResult(
    "",
    "Error code: 403\nYou've reached your usage limit for this billing cycle.\n",
    { exitCode: 1 },
  );

  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "usage_limited");
  assert.match(parsed.error, /usage limit/i);
  assert.equal(parsed.raw, "");
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

test("buildKimiArgs: rejects invalid max-step budgets", () => {
  for (const maxStepsPerTurn of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => buildKimiArgs(resolveProfile("review"), {
        model: "kimi-k2-turbo-preview",
        maxStepsPerTurn,
      }),
      /maxStepsPerTurn must be a positive integer/,
    );
  }
});
