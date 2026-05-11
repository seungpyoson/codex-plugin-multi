import { test } from "node:test";
import assert from "node:assert/strict";

const AUTH_MODULES = [
  {
    plugin: "claude",
    providerName: "Claude",
    keys: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
  },
  {
    plugin: "gemini",
    providerName: "Gemini",
    keys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  },
];

for (const { plugin, providerName, keys } of AUTH_MODULES) {
  test(`${plugin} auth-selection resolves modes and diagnostic fields`, async () => {
    const mod = await import(`../../plugins/${plugin}/scripts/lib/auth-selection.mjs`);
    const fail = (code, message) => {
      throw Object.assign(new Error(message), { code });
    };

    assert.deepEqual(
      mod.providerApiKeyEnv(keys, { [keys[0]]: "secret-value", [keys[1]]: "" }),
      [keys[0]],
    );

    const subscription = mod.resolveAuthSelection({
      requestedMode: "subscription",
      providerApiKeyEnvNames: keys,
      fail,
      env: { [keys[0]]: "secret-value" },
    });
    assert.deepEqual(subscription, {
      auth_mode: "subscription",
      selected_auth_path: "subscription_oauth",
      allowed_env_credentials: [],
      ignored_env_credentials: [keys[0]],
      auth_policy: "api_key_env_ignored",
    });
    assert.deepEqual(mod.authDiagnosticFields(subscription), {
      auth_mode: "subscription",
      selected_auth_path: "subscription_oauth",
      ignored_env_credentials: [keys[0]],
      auth_policy: "api_key_env_ignored",
    });

    const apiKey = mod.resolveAuthSelection({
      requestedMode: "api_key",
      providerApiKeyEnvNames: keys,
      fail,
      env: { [keys[1]]: "secret-value" },
    });
    assert.deepEqual(apiKey, {
      auth_mode: "api_key",
      selected_auth_path: "api_key_env",
      allowed_env_credentials: [keys[1]],
      ignored_env_credentials: [],
      auth_policy: "api_key_env_allowed",
    });
    assert.deepEqual(mod.authDiagnosticFields(apiKey), {
      auth_mode: "api_key",
      selected_auth_path: "api_key_env",
      allowed_env_credentials: [keys[1]],
      auth_policy: "api_key_env_allowed",
    });

    const apiKeyMissing = mod.resolveAuthSelection({
      requestedMode: "api_key",
      providerApiKeyEnvNames: keys,
      fail,
      env: {},
    });
    assert.deepEqual(apiKeyMissing, {
      auth_mode: "api_key",
      selected_auth_path: "api_key_env_missing",
      allowed_env_credentials: [],
      ignored_env_credentials: [],
      auth_policy: "api_key_env_required",
    });
    assert.deepEqual(mod.authDiagnosticFields(apiKeyMissing), {
      auth_mode: "api_key",
      selected_auth_path: "api_key_env_missing",
      auth_policy: "api_key_env_required",
    });
    assert.equal(
      mod.apiKeyMissingMessage(keys),
      `explicit api_key auth requires ${keys.join(" or ")} in the companion environment`,
    );
    assert.deepEqual(
      mod.apiKeyMissingFields({
        selection: apiKeyMissing,
        notAuthedFields: { target_spawned: false },
        providerName,
        providerApiKeyEnvNames: keys,
      }),
      {
        target_spawned: false,
        auth_mode: "api_key",
        selected_auth_path: "api_key_env_missing",
        auth_policy: "api_key_env_required",
        summary: `${providerName} API-key auth was requested, but no ${providerName} provider API key is available.`,
        next_action: `Set ${keys.join(" or ")}, or rerun with --auth-mode subscription after completing ${providerName} OAuth.`,
      },
    );

    assert.deepEqual(
      mod.resolveAuthSelection({
        requestedMode: "auto",
        providerApiKeyEnvNames: keys,
        fail,
        env: { [keys[0]]: "secret-value" },
      }),
      {
        auth_mode: "auto",
        selected_auth_path: "api_key_env",
        allowed_env_credentials: [keys[0]],
        ignored_env_credentials: [],
        auth_policy: "api_key_env_allowed",
      },
    );
    assert.deepEqual(
      mod.resolveAuthSelection({
        requestedMode: undefined,
        providerApiKeyEnvNames: keys,
        fail,
        env: {},
      }),
      {
        auth_mode: "auto",
        selected_auth_path: "subscription_oauth",
        allowed_env_credentials: [],
        ignored_env_credentials: [],
        auth_policy: "subscription_oauth",
      },
    );
    assert.deepEqual(
      mod.resolveAuthSelection({
        requestedMode: undefined,
        providerApiKeyEnvNames: keys,
        fail,
        env: { [keys[0]]: "secret-value" },
      }),
      {
        auth_mode: "auto",
        selected_auth_path: "api_key_env",
        allowed_env_credentials: [keys[0]],
        ignored_env_credentials: [],
        auth_policy: "api_key_env_allowed",
      },
    );

    assert.throws(
      () => mod.resolveAuthSelection({
        requestedMode: "bogus",
        providerApiKeyEnvNames: keys,
        fail,
        env: {},
      }),
      /--auth-mode must be one of subscription\|api_key\|auto/,
    );

    const failures = [];
    assert.equal(
      mod.resolveAuthSelection({
        requestedMode: "bogus",
        providerApiKeyEnvNames: keys,
        fail: (code, message) => failures.push({ code, message }),
        env: { [keys[0]]: "secret-value" },
      }),
      null,
    );
    assert.deepEqual(failures, [{
      code: "bad_args",
      message: "--auth-mode must be one of subscription|api_key|auto; got \"bogus\"",
    }]);
  });
}
