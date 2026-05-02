// Canonical source for plugin-local packaging copies. Run
// `node scripts/ci/sync-companion-common.mjs` after editing this file.

export const PING_PROMPT =
  "reply with exactly: pong. Do not use any tools, do not read files, and do not explore the workspace.";

export function preflightDisclosure(target) {
  return (
    `Preflight only: ${target} was not spawned, and no selected scope content ` +
    "was sent to the target CLI or external provider. A later successful " +
    `external review still sends the selected files to ${target}.`
  );
}

export function preflightSafetyFields() {
  return {
    target_spawned: false,
    selected_scope_sent_to_provider: false,
    requires_external_provider_consent: true,
  };
}

export function credentialNameDiagnostics(providerApiKeyEnv, env = process.env) {
  const ignored = providerApiKeyEnv.filter((key) => env[key]);
  if (ignored.length === 0) return {};
  return {
    ignored_env_credentials: ignored,
    auth_policy: "api_key_env_ignored",
  };
}
