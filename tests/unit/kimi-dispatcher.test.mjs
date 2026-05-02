import { test } from "node:test";
import assert from "node:assert/strict";

import { buildKimiArgs } from "../../plugins/kimi/scripts/lib/kimi.mjs";
import { MODE_PROFILES, resolveProfile } from "../../plugins/kimi/scripts/lib/mode-profiles.mjs";

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
