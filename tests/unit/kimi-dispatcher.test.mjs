import { test } from "node:test";
import assert from "node:assert/strict";

import { MODE_PROFILES } from "../../plugins/kimi/scripts/lib/mode-profiles.mjs";
import { providerApiCapability, sanitizeTargetEnv } from "../../plugins/kimi/scripts/lib/provider-env.mjs";

// kimi-code has no per-invocation tool restriction and no step budget, so the
// adapter no longer carries any tool-allowlist or max-step authority on the
// mode profiles. The ACP command surface itself is covered by
// kimi-code-surface.test.mjs and acp-client.test.mjs (spawnKimi / runAcpPrompt /
// acpResultToParsed). This file guards the profile table's contract and the spawn
// environment sanitization.

test("MODE_PROFILES: no profile carries dead tool-allowlist or step-budget authority", () => {
  for (const [name, profile] of Object.entries(MODE_PROFILES)) {
    for (const deadField of ["allowed_tools", "disallowed_tools", "exclude_tools", "max_steps_per_turn"]) {
      assert.equal(
        Object.hasOwn(profile, deadField),
        false,
        `${name} must not keep ${deadField} (kimi-code has no per-invocation tool/step restriction)`,
      );
    }
  }
});

test("MODE_PROFILES: review-family + ping embed source in the prompt (no workspace scope)", () => {
  for (const name of ["review", "adversarial-review", "custom-review", "ping"]) {
    assert.equal(MODE_PROFILES[name].add_dir, false, `${name} must not grant workspace scope for prompt-contained source review`);
  }
  // Rescue is the write-capable mode and runs in the working tree.
  assert.equal(MODE_PROFILES.rescue.add_dir, true, "rescue must keep working-tree access");
  assert.equal(MODE_PROFILES.rescue.permission_mode, "acceptEdits", "rescue must remain write-capable");
});

test("sanitizeTargetEnv: strips provider routing and API-key variables for Kimi", () => {
  const sanitized = sanitizeTargetEnv({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    KIMI_CONFIG_DIR: "/tmp/kimi",
    KIMI_API_KEY: "kimi-secret",
    MOONSHOT_BASE_URL: "https://moonshot.example",
    OPENAI_API_KEY: "openai-secret",
    AWS_PROFILE: "prod",
    GOOGLE_APPLICATION_CREDENTIALS: "/tmp/google.json",
    GOOGLE_GENAI_USE_VERTEXAI: "true",
    CLOUD_ML_REGION: "us-central1",
    LITELLM_PROXY_API_KEY: "proxy-secret",
    OLLAMA_HOST: "http://127.0.0.1:11434",
    HTTP_PROXY: "http://proxy.example",
  });

  assert.deepEqual(sanitized, {
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    KIMI_CONFIG_DIR: "/tmp/kimi",
    HTTP_PROXY: "http://proxy.example",
  });
});

test("sanitizeTargetEnv: strips proxy variables only when requested", () => {
  assert.deepEqual(
    sanitizeTargetEnv({
      PATH: "/usr/bin",
      HTTP_PROXY: "http://proxy.example",
      HTTPS_PROXY: "https://proxy.example",
      NO_PROXY: "localhost",
      npm_config_proxy: "http://npm-proxy.example",
      CODEX_PLUGIN_STRIP_PROXY_ENV: "1",
    }),
    { PATH: "/usr/bin" },
  );
});

test("sanitizeTargetEnv: accepts nullish env as empty", () => {
  assert.deepEqual(sanitizeTargetEnv(null), {});
});

test("providerApiCapability: exposes one canonical Grok direct API env name", () => {
  const capability = providerApiCapability("grok");
  assert.deepEqual(capability, {
    kind: "direct_api",
    auth_path: "api_key_env",
    credential_env_names: ["XAI_API_KEY"],
  });
  assert.deepEqual(providerApiCapability("unknown"), null);
});
