import { test } from "node:test";
import assert from "node:assert/strict";

import { buildKimiArgs } from "../../plugins/kimi/scripts/lib/kimi.mjs";
import { resolveProfile } from "../../plugins/kimi/scripts/lib/mode-profiles.mjs";

test("buildKimiArgs: review enables thinking mode", () => {
  const args = buildKimiArgs(resolveProfile("review"), {
    model: "kimi-code/kimi-for-coding",
  });

  assert.ok(args.includes("--thinking"));
  assert.equal(args[args.indexOf("-m") + 1], "kimi-code/kimi-for-coding");
  assert.ok(args.includes("--plan"));
});
