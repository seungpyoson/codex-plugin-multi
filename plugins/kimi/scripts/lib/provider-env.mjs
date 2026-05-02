// Provider credential / routing scrub policy.
//
// We strip three categories before launching the target CLI:
//   1. *_API_KEY suffixes — covers KIMI_CODE_API_KEY, MOONSHOT_API_KEY,
//      KIMI_API_KEY, OPENAI_API_KEY, etc.
//   2. Whole provider namespaces by prefix — every var that selects or
//      authenticates a provider region/project/profile, plus router/proxy
//      ecosystems (LITELLM_, OLLAMA_) that re-route Kimi traffic
//      to a third party. The router scrub is a deliberate decision (#16
//      follow-up 7): we want the target CLI to talk only to its first-party
//      provider via on-disk OAuth/config, not to a model proxy that the
//      companion's parent process happened to be configured for.
//   3. A small list of explicit non-prefixed selectors that don't fit (1)
//      or (2) but still steer providers (e.g. GOOGLE_GENAI_USE_VERTEXAI).
//
// Anything not on this list — PATH, HOME, terminal vars, NODE_*, target
// CLI config dirs (KIMI_CONFIG_DIR), etc. — is passed
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
  "MOONSHOT_",          // Moonshot API-key/direct endpoint config.
  "AWS_",               // creds + AWS_REGION + AWS_PROFILE + AWS_SESSION_TOKEN
  "AZURE_",             // AZURE_CLIENT_*, AZURE_TENANT_ID
  "VERTEX_",            // VERTEX_PROJECT, VERTEX_LOCATION
  "GOOGLE_CLOUD_",      // GOOGLE_CLOUD_PROJECT*, GOOGLE_CLOUD_REGION, ...
  "LITELLM_",           // router endpoint/auth — would re-route Claude/Kimi
  "OLLAMA_",            // local-model proxy — same blast radius
];
const PROVIDER_ENV_DENYLIST = new Set([
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "CLOUD_ML_REGION",
  // Companion control variable: read by sanitizeTargetEnv, never forwarded.
  "CODEX_PLUGIN_STRIP_PROXY_ENV",
]);

function isDeniedEnvKey(key) {
  const upper = key.toUpperCase();
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

export function sanitizeTargetEnv(env) {
  const sanitized = {};
  const stripProxyEnv = env?.CODEX_PLUGIN_STRIP_PROXY_ENV === "1";
  for (const [key, value] of Object.entries(env ?? {})) {
    if (isDeniedEnvKey(key)) continue;
    if (stripProxyEnv && isProxyEnvKey(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}
