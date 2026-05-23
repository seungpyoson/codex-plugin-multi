// Shared Claude/Gemini auth-selection helper source.
// Edit scripts/lib/auth-selection.mjs, then run
// `node scripts/ci/sync-auth-selection.mjs` to update plugin packaging copies.

import { selectProviderRoute } from "./provider-route-policy.mjs";

export const AUTH_MODE = Object.freeze({
  subscription: "subscription",
  apiKey: "api_key",
});

const AUTH_MODE_VALUES = new Set(Object.values(AUTH_MODE));

export function subscriptionAuthMode() {
  return AUTH_MODE.subscription;
}

export function apiKeyAuthMode() {
  return AUTH_MODE.apiKey;
}

export function defaultAuthMode() {
  return subscriptionAuthMode();
}

export function providerApiKeyEnv(providerApiKeyEnvNames, env = process.env) {
  return providerApiKeyEnvNames.filter((key) => env[key]);
}

export function resolveAuthSelection({
  requestedMode = defaultAuthMode(),
  providerApiKeyEnvNames,
  fail,
  env = process.env,
  sourceBearing = false,
  sourceSendApproved = false,
}) {
  const authMode = requestedMode ?? defaultAuthMode();
  if (!AUTH_MODE_VALUES.has(authMode)) {
    fail("bad_args", `--auth-mode must be one of subscription|api_key; got ${JSON.stringify(authMode)}`);
    return null;
  }
  const apiKeyEnvNames = Array.isArray(providerApiKeyEnvNames) ? providerApiKeyEnvNames : [];
  const route = selectProviderRoute({
    requestedRoute: authMode === apiKeyAuthMode() ? "api" : "subscription",
    fallbackReason: authMode === apiKeyAuthMode() ? "explicit_api" : null,
    providerCapabilities: {
      subscription: { kind: "oauth", auth_path: "subscription_oauth" },
      api: {
        kind: "direct_api",
        auth_path: "api_key_env",
        credential_env_names: apiKeyEnvNames,
      },
    },
    env,
    sourceBearing,
    sourceSendApproved,
    fail,
  });
  if (!route) return null;
  if (route.route_mode === "api") {
    return {
      auth_mode: authMode,
      selected_auth_path: route.auth_path,
      auth_path: route.auth_path,
      billing_path: route.billing_path,
      selected_route: route.selected_route,
      fallback_reason: route.fallback_reason,
      source_send_approval_required: route.source_send_approval_required,
      source_send_approval_state: route.source_send_approval_state,
      allowed_env_credentials: route.allowed_env_credentials,
      ignored_env_credentials: [],
      auth_policy: route.allowed_env_credentials.length > 0 ? "api_key_env_allowed" : "api_key_env_required",
    };
  }
  return {
    auth_mode: authMode,
    selected_auth_path: route.auth_path,
    auth_path: route.auth_path,
    billing_path: route.billing_path,
    selected_route: route.selected_route,
    fallback_reason: route.fallback_reason,
    source_send_approval_required: route.source_send_approval_required,
    source_send_approval_state: route.source_send_approval_state,
    allowed_env_credentials: [],
    ignored_env_credentials: route.ignored_env_credentials,
    auth_policy: route.ignored_env_credentials.length > 0 ? "api_key_env_ignored" : "subscription_oauth",
  };
}

function presentEnvForCredentialNames(names) {
  return Object.fromEntries(names.map((name) => [name, "present"]));
}

export function apiKeyFallbackSelection(selection, reason = "subscription_unavailable", options = null) {
  if (!options || typeof options.sourceBearing !== "boolean") {
    throw new Error("apiKeyFallbackSelection requires explicit sourceBearing");
  }
  const fallbackKeys = Array.isArray(selection?.ignored_env_credentials)
    ? selection.ignored_env_credentials
    : [];
  if (selection?.selected_auth_path !== "subscription_oauth" || fallbackKeys.length === 0) return null;
  const route = selectProviderRoute({
    requestedRoute: "api",
    fallbackReason: reason,
    providerCapabilities: {
      subscription: { kind: "oauth", auth_path: "subscription_oauth" },
      api: {
        kind: "direct_api",
        auth_path: "api_key_env",
        credential_env_names: fallbackKeys,
      },
    },
    env: presentEnvForCredentialNames(fallbackKeys),
    sourceBearing: options.sourceBearing,
    sourceSendApproved: options.sourceSendApproved === true,
  });
  return {
    auth_mode: selection.auth_mode ?? defaultAuthMode(),
    selected_auth_path: route.auth_path,
    auth_path: route.auth_path,
    billing_path: route.billing_path,
    selected_route: route.selected_route,
    fallback_reason: route.fallback_reason,
    source_send_approval_required: route.source_send_approval_required,
    source_send_approval_state: route.source_send_approval_state,
    allowed_env_credentials: route.allowed_env_credentials,
    ignored_env_credentials: [],
    auth_policy: "api_key_env_fallback",
    auth_fallback: {
      from: "subscription_oauth",
      to: "api_key_env",
      reason,
    },
  };
}

export function authDiagnosticFields(selection) {
  return {
    auth_mode: selection.auth_mode,
    selected_auth_path: selection.selected_auth_path,
    auth_path: selection.auth_path ?? selection.selected_auth_path ?? null,
    billing_path: selection.billing_path ?? null,
    selected_route: selection.selected_route ?? null,
    fallback_reason: selection.fallback_reason ?? null,
    source_send_approval_required: selection.source_send_approval_required ?? null,
    source_send_approval_state: selection.source_send_approval_state ?? null,
    ...(selection.allowed_env_credentials.length > 0 ? { allowed_env_credentials: selection.allowed_env_credentials } : {}),
    ...(selection.ignored_env_credentials.length > 0 ? { ignored_env_credentials: selection.ignored_env_credentials } : {}),
    auth_policy: selection.auth_policy,
    ...(selection.auth_fallback ? { auth_fallback: selection.auth_fallback } : {}),
  };
}

export function apiKeyMissingMessage(providerApiKeyEnvNames) {
  return `explicit api_key auth requires ${providerApiKeyEnvNames.join(" or ")} in the companion environment`;
}

export function apiKeyMissingFields({
  selection,
  notAuthedFields,
  providerName,
  providerApiKeyEnvNames,
}) {
  return {
    ...notAuthedFields,
    ...authDiagnosticFields(selection),
    summary: `${providerName} API-key auth was requested, but no ${providerName} provider API key is available.`,
    next_action: `Set ${providerApiKeyEnvNames.join(" or ")}, or rerun with --auth-mode subscription after completing ${providerName} OAuth.`,
  };
}
