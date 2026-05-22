// Shared external-model provider-env helper source.
// Edit scripts/lib/provider-env.mjs, then run
// `node scripts/ci/sync-provider-env.mjs` to update plugin packaging copies.

// Provider credential / routing scrub policy.
//
// We strip three categories before launching the target CLI:
//   1. *_API_KEY suffixes — covers ANTHROPIC_API_KEY, CLAUDE_API_KEY,
//      OPENAI_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY, etc.
//   2. Whole provider namespaces by prefix — every var that selects or
//      authenticates a provider region/project/profile, plus router/proxy
//      ecosystems (LITELLM_, OLLAMA_) that re-route external-model traffic
//      to a third party. The target CLI should talk only to its first-party
//      subscription auth, not to a model proxy or API key inherited from the
//      companion's parent process.
//   3. A small list of explicit non-prefixed selectors that don't fit (1)
//      or (2) but still steer providers (e.g. GOOGLE_GENAI_USE_VERTEXAI).
//
// Anything not on this list — PATH, HOME, terminal vars, NODE_*, target
// CLI config dirs (CLAUDE_CONFIG_DIR, GEMINI_CONFIG_DIR), etc. — is passed
// through so OAuth / on-disk creds keep working.
//
// DEFAULT: HTTP_PROXY / HTTPS_PROXY / NO_PROXY / *_proxy are preserved.
// In corporate environments those are how the target CLI reaches the public
// internet at all, and stripping them would break setup probes and OAuth
// refresh on locked-down networks. Operators who prefer strict isolation can
// set CODEX_PLUGIN_STRIP_PROXY_ENV=1 to strip those proxy variables too.
const PROVIDER_PREFIXES = [
  "ANTHROPIC_",
  "CLAUDE_CODE_USE_",   // CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX
  "OPENAI_",            // OPENAI_BASE_URL, OPENAI_PROJECT, OPENAI_ORG_ID, ...
  "MOONSHOT_",          // Moonshot/Kimi API-key/direct endpoint config.
  "DEEPSEEK_",          // DeepSeek API-key/direct endpoint config.
  "ZAI_",               // Z.ai / GLM API-key/direct endpoint config.
  "GLM_",               // GLM API-key/direct endpoint config.
  "XAI_",               // xAI/Grok API-key/direct endpoint config.
  "AWS_",               // creds + AWS_REGION + AWS_PROFILE + AWS_SESSION_TOKEN
  "AZURE_",             // AZURE_CLIENT_*, AZURE_TENANT_ID
  "VERTEX_",            // VERTEX_PROJECT, VERTEX_LOCATION
  "GOOGLE_CLOUD_",      // GOOGLE_CLOUD_PROJECT*, GOOGLE_CLOUD_REGION, ...
  "LITELLM_",           // router endpoint/auth — would re-route provider CLIs
  "OLLAMA_",            // local-model proxy — same blast radius
];
const PROVIDER_ENV_DENYLIST = new Set([
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "CLOUD_ML_REGION",
  // Companion control variable: read by sanitizeTargetEnv, never forwarded.
  "CODEX_PLUGIN_STRIP_PROXY_ENV",
]);

const PROVIDER_API_CAPABILITIES = Object.freeze({
  grok: Object.freeze({
    kind: "direct_api",
    auth_path: "api_key_env",
    credential_env_names: Object.freeze(["XAI_API_KEY"]),
  }),
});

export function providerApiCapability(provider) {
  const capability = PROVIDER_API_CAPABILITIES[String(provider ?? "").toLowerCase()];
  if (!capability) return null;
  return {
    ...capability,
    credential_env_names: [...capability.credential_env_names],
  };
}

function isDeniedEnvKey(key, allowedApiKeyEnv) {
  const upper = key.toUpperCase();
  if (allowedApiKeyEnv.has(upper)) return false;
  if (upper.endsWith("_API_KEY")) return true;
  if (PROVIDER_ENV_DENYLIST.has(upper)) return true;
  for (const prefix of PROVIDER_PREFIXES) {
    if (upper.startsWith(prefix)) return true;
  }
  return false;
}

function isProxyEnvKey(key) {
  return key.toUpperCase().endsWith("_PROXY");
}

export function sanitizeTargetEnv(env, options = {}) {
  const sanitized = {};
  const allowedApiKeyEnv = new Set((options.allowedApiKeyEnv ?? []).map((key) => String(key).toUpperCase()));
  const stripProxyEnv = env?.CODEX_PLUGIN_STRIP_PROXY_ENV === "1";
  for (const [key, value] of Object.entries(env ?? {})) {
    if (isDeniedEnvKey(key, allowedApiKeyEnv)) continue;
    if (stripProxyEnv && isProxyEnvKey(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}
