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

const SUBSCRIPTION_ROUTE_STEPS = [
  {
    route: "subscription",
    supported: true,
    attempted: true,
    selected: true,
    skipped_reason: null,
    fallback_reason: null,
  },
  {
    route: "direct_api",
    supported: true,
    attempted: true,
    selected: false,
    skipped_reason: "not_needed",
    fallback_reason: null,
  },
  {
    route: "openrouter",
    supported: false,
    attempted: true,
    selected: false,
    skipped_reason: "unsupported",
    fallback_reason: null,
  },
];

function directApiRouteSteps(fallbackReason) {
  return [
    {
      route: "subscription",
      supported: true,
      attempted: true,
      selected: false,
      skipped_reason: "not_requested",
      fallback_reason: fallbackReason,
    },
    {
      route: "direct_api",
      supported: true,
      attempted: true,
      selected: true,
      skipped_reason: null,
      fallback_reason: fallbackReason,
    },
    {
      route: "openrouter",
      supported: false,
      attempted: true,
      selected: false,
      skipped_reason: "unsupported",
      fallback_reason: null,
    },
  ];
}

for (const { plugin, providerName, keys } of AUTH_MODULES) {
  test(`${plugin} auth-selection resolves modes and diagnostic fields`, async () => {
    const mod = await import(`../../plugins/${plugin}/scripts/lib/auth-selection.mjs`);
    const subscriptionMode = mod.subscriptionAuthMode();
    const apiKeyMode = mod.apiKeyAuthMode();
    const fail = (code, message) => {
      throw Object.assign(new Error(message), { code });
    };

    assert.deepEqual(
      mod.providerApiKeyEnv(keys, { [keys[0]]: "secret-value", [keys[1]]: "" }),
      [keys[0]],
    );
    assert.deepEqual(
      mod.providerApiKeyEnv([], {}),
      [],
    );

    const subscription = mod.resolveAuthSelection({
      requestedMode: subscriptionMode,
      providerApiKeyEnvNames: keys,
      fail,
      env: { [keys[0]]: "secret-value" },
    });
    assert.deepEqual(subscription, {
      auth_mode: subscriptionMode,
      selected_auth_path: "subscription_oauth",
      auth_path: "subscription_oauth",
      billing_path: null,
      selected_route: "subscription_oauth",
      route_step: "subscription",
      route_steps: SUBSCRIPTION_ROUTE_STEPS,
      fallback_reason: null,
      source_send_approval_required: false,
      source_send_approval_state: "not_required",
      allowed_env_credentials: [],
      ignored_env_credentials: [keys[0]],
      auth_policy: "api_key_env_ignored",
    });
    assert.deepEqual(mod.authDiagnosticFields(subscription), {
      auth_mode: subscriptionMode,
      selected_auth_path: "subscription_oauth",
      auth_path: "subscription_oauth",
      billing_path: null,
      selected_route: "subscription_oauth",
      route_step: "subscription",
      route_steps: SUBSCRIPTION_ROUTE_STEPS,
      fallback_reason: null,
      source_send_approval_required: false,
      source_send_approval_state: "not_required",
      ignored_env_credentials: [keys[0]],
      auth_policy: "api_key_env_ignored",
    });

    const subscriptionWithNonArrayKeys = mod.resolveAuthSelection({
      requestedMode: subscriptionMode,
      providerApiKeyEnvNames: null,
      fail,
      env: { [keys[0]]: "secret-value" },
    });
    assert.deepEqual(subscriptionWithNonArrayKeys.ignored_env_credentials, []);
    assert.equal(subscriptionWithNonArrayKeys.auth_policy, "subscription_oauth");

    const apiKey = mod.resolveAuthSelection({
      requestedMode: apiKeyMode,
      providerApiKeyEnvNames: keys,
      fail,
      env: { [keys[1]]: "secret-value" },
    });
    assert.deepEqual(apiKey, {
      auth_mode: apiKeyMode,
      selected_auth_path: "api_key_env",
      auth_path: "api_key_env",
      billing_path: null,
      selected_route: "direct_api",
      route_step: "direct_api",
      route_steps: directApiRouteSteps("explicit_api"),
      fallback_reason: "explicit_api",
      source_send_approval_required: false,
      source_send_approval_state: "not_required",
      allowed_env_credentials: [keys[1]],
      ignored_env_credentials: [],
      auth_policy: "api_key_env_allowed",
    });
    assert.deepEqual(mod.authDiagnosticFields(apiKey), {
      auth_mode: apiKeyMode,
      selected_auth_path: "api_key_env",
      auth_path: "api_key_env",
      billing_path: null,
      selected_route: "direct_api",
      route_step: "direct_api",
      route_steps: directApiRouteSteps("explicit_api"),
      fallback_reason: "explicit_api",
      source_send_approval_required: false,
      source_send_approval_state: "not_required",
      allowed_env_credentials: [keys[1]],
      auth_policy: "api_key_env_allowed",
    });

    const sourceBearingApiKey = mod.resolveAuthSelection({
      requestedMode: apiKeyMode,
      providerApiKeyEnvNames: keys,
      fail,
      env: { [keys[1]]: "secret-value" },
      sourceBearing: true,
    });
    assert.equal(sourceBearingApiKey.selected_route, "direct_api");
    assert.equal(sourceBearingApiKey.fallback_reason, "explicit_api");
    assert.equal(sourceBearingApiKey.source_send_approval_required, true);
    assert.equal(sourceBearingApiKey.source_send_approval_state, "required");

    const approvedSourceBearingApiKey = mod.resolveAuthSelection({
      requestedMode: apiKeyMode,
      providerApiKeyEnvNames: keys,
      fail,
      env: { [keys[1]]: "secret-value" },
      sourceBearing: true,
      sourceSendApproved: true,
    });
    assert.equal(approvedSourceBearingApiKey.selected_route, "direct_api");
    assert.equal(approvedSourceBearingApiKey.source_send_approval_required, true);
    assert.equal(approvedSourceBearingApiKey.source_send_approval_state, "approved");

    const apiKeyMissing = mod.resolveAuthSelection({
      requestedMode: apiKeyMode,
      providerApiKeyEnvNames: keys,
      fail,
      env: {},
    });
    assert.deepEqual(apiKeyMissing, {
      auth_mode: apiKeyMode,
      selected_auth_path: "api_key_env_missing",
      auth_path: "api_key_env_missing",
      billing_path: null,
      selected_route: "direct_api",
      route_step: "direct_api",
      route_steps: directApiRouteSteps("explicit_api"),
      fallback_reason: "explicit_api",
      source_send_approval_required: false,
      source_send_approval_state: "not_required",
      allowed_env_credentials: [],
      ignored_env_credentials: [],
      auth_policy: "api_key_env_required",
    });
    assert.deepEqual(mod.authDiagnosticFields(apiKeyMissing), {
      auth_mode: apiKeyMode,
      selected_auth_path: "api_key_env_missing",
      auth_path: "api_key_env_missing",
      billing_path: null,
      selected_route: "direct_api",
      route_step: "direct_api",
      route_steps: directApiRouteSteps("explicit_api"),
      fallback_reason: "explicit_api",
      source_send_approval_required: false,
      source_send_approval_state: "not_required",
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
        auth_mode: apiKeyMode,
        selected_auth_path: "api_key_env_missing",
        auth_path: "api_key_env_missing",
        billing_path: null,
        selected_route: "direct_api",
        route_step: "direct_api",
        route_steps: directApiRouteSteps("explicit_api"),
        fallback_reason: "explicit_api",
        source_send_approval_required: false,
        source_send_approval_state: "not_required",
        auth_policy: "api_key_env_required",
        summary: `${providerName} API-key auth was requested, but no ${providerName} provider API key is available.`,
        next_action: `Set ${keys.join(" or ")}, or rerun with --auth-mode subscription after completing ${providerName} OAuth.`,
      },
    );

    assert.throws(
      () => mod.resolveAuthSelection({
        requestedMode: "auto",
        providerApiKeyEnvNames: keys,
        fail,
        env: { [keys[0]]: "secret-value" },
      }),
      /--auth-mode must be one of subscription\|api_key; got "auto"/,
    );
    const subscriptionWithKey = mod.resolveAuthSelection({
      requestedMode: subscriptionMode,
      providerApiKeyEnvNames: keys,
      fail,
      env: { [keys[0]]: "secret-value" },
    });
    assert.throws(
      () => mod.apiKeyFallbackSelection(subscriptionWithKey, "not_authed"),
      /requires explicit sourceBearing/,
    );
    assert.deepEqual(mod.authDiagnosticFields({
      auth_mode: subscriptionMode,
      selected_auth_path: "subscription_oauth",
      allowed_env_credentials: [],
      ignored_env_credentials: [],
      auth_policy: "subscription_oauth",
    }), {
      auth_mode: subscriptionMode,
      selected_auth_path: "subscription_oauth",
      auth_path: "subscription_oauth",
      billing_path: null,
      selected_route: null,
      route_step: null,
      route_steps: null,
      fallback_reason: null,
      source_send_approval_required: null,
      source_send_approval_state: null,
      auth_policy: "subscription_oauth",
    });
    const fallback = mod.apiKeyFallbackSelection(subscriptionWithKey, "not_authed", { sourceBearing: false });
    assert.deepEqual(fallback, {
      auth_mode: subscriptionMode,
      selected_auth_path: "api_key_env",
      auth_path: "api_key_env",
      billing_path: null,
      selected_route: "direct_api",
      route_step: "direct_api",
      route_steps: directApiRouteSteps("not_authed"),
      fallback_reason: "not_authed",
      source_send_approval_required: false,
      source_send_approval_state: "not_required",
      allowed_env_credentials: [keys[0]],
      ignored_env_credentials: [],
      auth_policy: "api_key_env_fallback",
      auth_fallback: {
        from: "subscription_oauth",
        to: "api_key_env",
        reason: "not_authed",
      },
    });
    assert.deepEqual(mod.authDiagnosticFields(fallback), {
      auth_mode: subscriptionMode,
      selected_auth_path: "api_key_env",
      auth_path: "api_key_env",
      billing_path: null,
      selected_route: "direct_api",
      route_step: "direct_api",
      route_steps: directApiRouteSteps("not_authed"),
      fallback_reason: "not_authed",
      source_send_approval_required: false,
      source_send_approval_state: "not_required",
      allowed_env_credentials: [keys[0]],
      auth_policy: "api_key_env_fallback",
      auth_fallback: {
        from: "subscription_oauth",
        to: "api_key_env",
        reason: "not_authed",
      },
    });
    const sourceBearingFallback = mod.apiKeyFallbackSelection(subscriptionWithKey, "not_authed", {
      sourceBearing: true,
      sourceSendApproved: false,
    });
    assert.equal(sourceBearingFallback.source_send_approval_required, true);
    assert.equal(sourceBearingFallback.source_send_approval_state, "required");
    const approvedSourceBearingFallback = mod.apiKeyFallbackSelection(subscriptionWithKey, "not_authed", {
      sourceBearing: true,
      sourceSendApproved: true,
    });
    assert.equal(approvedSourceBearingFallback.source_send_approval_required, true);
    assert.equal(approvedSourceBearingFallback.source_send_approval_state, "approved");
    const subscriptionWithoutKeyForFallback = mod.resolveAuthSelection({
      requestedMode: subscriptionMode,
      providerApiKeyEnvNames: keys,
      fail,
      env: {},
    });
    assert.equal(
      mod.apiKeyFallbackSelection(subscriptionWithoutKeyForFallback, "not_authed", { sourceBearing: false }),
      null,
    );
    assert.equal(
      mod.apiKeyFallbackSelection(
        { auth_mode: subscriptionMode, ignored_env_credentials: null },
        "not_authed",
        { sourceBearing: false },
      ),
      null,
    );
    assert.deepEqual(
      mod.resolveAuthSelection({
        requestedMode: undefined,
        providerApiKeyEnvNames: keys,
        fail,
        env: {},
      }),
      {
        auth_mode: subscriptionMode,
        selected_auth_path: "subscription_oauth",
        auth_path: "subscription_oauth",
        billing_path: null,
        selected_route: "subscription_oauth",
        route_step: "subscription",
        route_steps: SUBSCRIPTION_ROUTE_STEPS,
        fallback_reason: null,
        source_send_approval_required: false,
        source_send_approval_state: "not_required",
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
        auth_mode: subscriptionMode,
        selected_auth_path: "subscription_oauth",
        auth_path: "subscription_oauth",
        billing_path: null,
        selected_route: "subscription_oauth",
        route_step: "subscription",
        route_steps: SUBSCRIPTION_ROUTE_STEPS,
        fallback_reason: null,
        source_send_approval_required: false,
        source_send_approval_state: "not_required",
        allowed_env_credentials: [],
        ignored_env_credentials: [keys[0]],
        auth_policy: "api_key_env_ignored",
      },
    );

    assert.throws(
      () => mod.resolveAuthSelection({
        requestedMode: "bogus",
        providerApiKeyEnvNames: keys,
        fail,
        env: {},
      }),
      /--auth-mode must be one of subscription\|api_key/,
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
      message: "--auth-mode must be one of subscription|api_key; got \"bogus\"",
    }]);
  });
}
