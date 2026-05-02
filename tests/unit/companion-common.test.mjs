import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PING_PROMPT,
  credentialNameDiagnostics,
  preflightDisclosure,
  preflightSafetyFields,
} from "../../scripts/lib/companion-common.mjs";

test("companion-common exposes the shared ping prompt", () => {
  assert.equal(
    PING_PROMPT,
    "reply with exactly: pong. Do not use any tools, do not read files, and do not explore the workspace.",
  );
});

test("companion-common builds provider preflight safety fields", () => {
  assert.deepEqual(preflightSafetyFields(), {
    target_spawned: false,
    selected_scope_sent_to_provider: false,
    requires_external_provider_consent: true,
  });
  assert.match(preflightDisclosure("Claude"), /Claude was not spawned/);
  assert.match(preflightDisclosure("Gemini"), /external review still sends/);
});

test("credentialNameDiagnostics reports key names only", () => {
  const result = credentialNameDiagnostics(["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"], {
    ANTHROPIC_API_KEY: "secret-test-value",
    CLAUDE_API_KEY: "",
  });
  assert.deepEqual(result, {
    ignored_env_credentials: ["ANTHROPIC_API_KEY"],
    auth_policy: "api_key_env_ignored",
  });
  assert.doesNotMatch(JSON.stringify(result), /secret-test-value/);
});

test("credentialNameDiagnostics omits fields when no provider key is present", () => {
  assert.deepEqual(credentialNameDiagnostics(["ANTHROPIC_API_KEY"], {}), {});
});

test("plugin packaging copies expose the canonical helper behavior", async () => {
  const modules = await Promise.all([
    import("../../plugins/claude/scripts/lib/companion-common.mjs"),
    import("../../plugins/gemini/scripts/lib/companion-common.mjs"),
    import("../../plugins/kimi/scripts/lib/companion-common.mjs"),
  ]);
  for (const mod of modules) {
    assert.equal(mod.PING_PROMPT, PING_PROMPT);
    assert.deepEqual(mod.preflightSafetyFields(), preflightSafetyFields());
    assert.equal(mod.preflightDisclosure("Target"), preflightDisclosure("Target"));
    assert.deepEqual(
      mod.credentialNameDiagnostics(["PROVIDER_API_KEY"], { PROVIDER_API_KEY: "secret-test-value" }),
      credentialNameDiagnostics(["PROVIDER_API_KEY"], { PROVIDER_API_KEY: "secret-test-value" }),
    );
    assert.deepEqual(
      mod.credentialNameDiagnostics(["__CODEX_PLUGIN_MULTI_MISSING_TEST_KEY__"]),
      credentialNameDiagnostics(["__CODEX_PLUGIN_MULTI_MISSING_TEST_KEY__"]),
    );
  }
});
