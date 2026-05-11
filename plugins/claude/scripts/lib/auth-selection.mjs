// Shared Claude/Gemini auth-selection helper source.
// Edit scripts/lib/auth-selection.mjs, then run
// `node scripts/ci/sync-auth-selection.mjs` to update plugin packaging copies.

const AUTH_MODES = new Set(["subscription", "api_key", "auto"]);

export function providerApiKeyEnv(providerApiKeyEnvNames, env = process.env) {
  return providerApiKeyEnvNames.filter((key) => env[key]);
}

export function resolveAuthSelection({
  requestedMode = "auto",
  providerApiKeyEnvNames,
  fail,
  env = process.env,
}) {
  const authMode = requestedMode ?? "auto";
  if (!AUTH_MODES.has(authMode)) {
    fail("bad_args", `--auth-mode must be one of subscription|api_key|auto; got ${JSON.stringify(authMode)}`);
    return null;
  }
  const providerKeys = providerApiKeyEnv(providerApiKeyEnvNames, env);
  if (authMode === "api_key") {
    return {
      auth_mode: authMode,
      selected_auth_path: providerKeys.length > 0 ? "api_key_env" : "api_key_env_missing",
      allowed_env_credentials: providerKeys,
      ignored_env_credentials: [],
      auth_policy: providerKeys.length > 0 ? "api_key_env_allowed" : "api_key_env_required",
    };
  }
  if (authMode === "auto" && providerKeys.length > 0) {
    return {
      auth_mode: authMode,
      selected_auth_path: "api_key_env",
      allowed_env_credentials: providerKeys,
      ignored_env_credentials: [],
      auth_policy: "api_key_env_allowed",
    };
  }
  return {
    auth_mode: authMode,
    selected_auth_path: "subscription_oauth",
    allowed_env_credentials: [],
    ignored_env_credentials: providerKeys,
    auth_policy: providerKeys.length > 0 ? "api_key_env_ignored" : "subscription_oauth",
  };
}

export function authDiagnosticFields(selection) {
  return {
    auth_mode: selection.auth_mode,
    selected_auth_path: selection.selected_auth_path,
    ...(selection.allowed_env_credentials.length > 0 ? { allowed_env_credentials: selection.allowed_env_credentials } : {}),
    ...(selection.ignored_env_credentials.length > 0 ? { ignored_env_credentials: selection.ignored_env_credentials } : {}),
    auth_policy: selection.auth_policy,
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
