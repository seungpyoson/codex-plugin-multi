import { test } from "node:test";
import assert from "node:assert/strict";

import { isCodexSandbox } from "../../scripts/lib/codex-env.mjs";

test("isCodexSandbox: treats absent and false-like CODEX_SANDBOX values as outside Codex", () => {
  for (const env of [
    null,
    undefined,
    {},
    { CODEX_SANDBOX: "" },
    { CODEX_SANDBOX: " " },
    { CODEX_SANDBOX: "false" },
    { CODEX_SANDBOX: "False" },
    { CODEX_SANDBOX: "0" },
    { CODEX_SANDBOX: "no" },
    { CODEX_SANDBOX: "off" },
    { CODEX_SANDBOX: "null" },
    { CODEX_SANDBOX: "undefined" },
    { CODEX_SANDBOX: "nil" },
  ]) {
    assert.equal(isCodexSandbox(env), false, `expected false for ${JSON.stringify(env)}`);
  }
});

test("isCodexSandbox: treats any other CODEX_SANDBOX value as inside Codex", () => {
  for (const value of ["seatbelt", "landlock", "true", "1", "yes", "on", "workspace-write"]) {
    assert.equal(isCodexSandbox({ CODEX_SANDBOX: value }), true, `expected true for ${value}`);
  }
});
