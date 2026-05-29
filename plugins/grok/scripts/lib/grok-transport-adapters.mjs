import { providerApiCapability } from "./provider-env.mjs";

const DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";
const DEFAULT_GROK2API_BASE_URL = "http://127.0.0.1:8000";
const DEFAULT_GROK2API_ADMIN_KEY = "grok2api";
const DEFAULT_WEB_MODEL = "grok-4.20-fast";
const DEFAULT_CLI_MODEL = "grok-build";
const DEFAULT_TIMEOUT_MS = 900000;
const DEFAULT_DOCTOR_TIMEOUT_MS = 2000;
const DEFAULT_CHAT_DOCTOR_TIMEOUT_MS = 10000;
const DEFAULT_TUNNEL_START_TIMEOUT_MS = 8000;
const DEFAULT_TUNNEL_CLEANUP_TIMEOUT_MS = 2000;
const DEFAULT_CLI_MAX_TURNS = 8;
const DEFAULT_MAX_PROMPT_CHARS = 400000;
const VALID_TRANSPORTS = new Set(["cli", "web", "auto"]);
const GROK_CLI_AUTO_FALLBACK_CODES = new Set([
  "grok_cli_unavailable",
  "grok_cli_auth_unavailable",
  "grok_cli_login_required",
  "grok_cli_auth_timeout",
  "grok_cli_model_unavailable",
]);

function normalizeBaseUrl(value) {
  let url = String(value || DEFAULT_BASE_URL);
  while (url.endsWith("/")) url = url.slice(0, -1);
  return url;
}

function normalizeGrok2ApiBaseUrl(value, tunnelBaseUrl = DEFAULT_BASE_URL) {
  const fallback = normalizeBaseUrl(tunnelBaseUrl).replace(/\/(?:(?:api\/)?v1|api)$/u, "");
  let url = String(value || fallback || DEFAULT_GROK2API_BASE_URL);
  url = url.replace(/\/+$/, "");
  return url.replace(/\/(?:(?:api\/)?v1|api)$/u, "");
}

function parsePositiveIntegerEnv(env, name, fallback, unit = "number of milliseconds") {
  const value = env[name];
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`bad_args: ${name} must be a positive integer ${unit}; got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function cliConfig(options = {}, env = process.env) {
  return {
    provider: "grok",
    display_name: "Grok CLI",
    auth_mode: "subscription_cli",
    selected_route: "subscription_cli",
    transport: "cli",
    requested_transport: options.requestedTransport ?? "cli",
    fallback_from: options.fallbackFrom ?? null,
    fallback_reason: options.fallbackReason ?? null,
    binary: env.GROK_CLI_BINARY || "grok",
    base_url: null,
    model: env.GROK_CLI_MODEL || DEFAULT_CLI_MODEL,
    timeout_ms: parsePositiveIntegerEnv(env, "GROK_CLI_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    max_prompt_chars: parsePositiveIntegerEnv(env, "GROK_CLI_MAX_PROMPT_CHARS", DEFAULT_MAX_PROMPT_CHARS, "character count"),
    max_turns: parsePositiveIntegerEnv(env, "GROK_CLI_MAX_TURNS", DEFAULT_CLI_MAX_TURNS, "turn count"),
    prompt_budget_env: "GROK_CLI_MAX_PROMPT_CHARS",
    default_model_env: "GROK_CLI_MODEL",
    timeout_env: "GROK_CLI_TIMEOUT_MS",
    legacy: false,
    credential_ref: null,
    credential_value: null,
    api_capability: providerApiCapability("grok"),
  };
}

function cliFallbackConfig(options = {}, env = process.env) {
  return {
    provider: "grok",
    display_name: "Grok CLI",
    auth_mode: "subscription_cli",
    selected_route: "subscription_cli",
    transport: "cli",
    requested_transport: options.requestedTransport ?? "cli",
    fallback_from: options.fallbackFrom ?? null,
    fallback_reason: options.fallbackReason ?? null,
    binary: env.GROK_CLI_BINARY || "grok",
    base_url: null,
    model: env.GROK_CLI_MODEL || DEFAULT_CLI_MODEL,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    max_prompt_chars: DEFAULT_MAX_PROMPT_CHARS,
    max_turns: DEFAULT_CLI_MAX_TURNS,
    prompt_budget_env: "GROK_CLI_MAX_PROMPT_CHARS",
    default_model_env: "GROK_CLI_MODEL",
    timeout_env: "GROK_CLI_TIMEOUT_MS",
    legacy: false,
    credential_ref: null,
    credential_value: null,
    api_capability: providerApiCapability("grok"),
  };
}

function webConfig(options = {}, env = process.env) {
  const rawTransport = String(options.transport ?? env.GROK_TRANSPORT ?? "web").trim().toLowerCase();
  return {
    provider: "grok-web",
    display_name: "Grok Web",
    auth_mode: "subscription_web",
    selected_route: "subscription_web",
    transport: "web",
    requested_transport: options.requestedTransport ?? "web",
    fallback_from: options.fallbackFrom ?? null,
    fallback_reason: options.fallbackReason ?? null,
    base_url: normalizeBaseUrl(env.GROK_WEB_BASE_URL),
    model: env.GROK_WEB_MODEL || DEFAULT_WEB_MODEL,
    timeout_ms: parsePositiveIntegerEnv(env, "GROK_WEB_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    doctor_timeout_ms: parsePositiveIntegerEnv(env, "GROK_WEB_DOCTOR_TIMEOUT_MS", DEFAULT_DOCTOR_TIMEOUT_MS),
    chat_doctor_timeout_ms: parsePositiveIntegerEnv(env, "GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS", DEFAULT_CHAT_DOCTOR_TIMEOUT_MS),
    tunnel_start_timeout_ms: parsePositiveIntegerEnv(env, "GROK_WEB_TUNNEL_START_TIMEOUT_MS", DEFAULT_TUNNEL_START_TIMEOUT_MS),
    tunnel_cleanup_timeout_ms: parsePositiveIntegerEnv(env, "GROK_WEB_TUNNEL_CLEANUP_TIMEOUT_MS", DEFAULT_TUNNEL_CLEANUP_TIMEOUT_MS),
    max_prompt_chars: parsePositiveIntegerEnv(env, "GROK_WEB_MAX_PROMPT_CHARS", DEFAULT_MAX_PROMPT_CHARS, "character count"),
    prompt_budget_env: "GROK_WEB_MAX_PROMPT_CHARS",
    default_model_env: "GROK_WEB_MODEL",
    timeout_env: "GROK_WEB_TIMEOUT_MS",
    legacy: rawTransport === "legacy" || rawTransport === "tunnel" || rawTransport === "grok-web",
    credential_ref: env.GROK_WEB_TUNNEL_API_KEY ? "GROK_WEB_TUNNEL_API_KEY" : null,
    credential_value: env.GROK_WEB_TUNNEL_API_KEY || null,
    grok2api_base_url: normalizeGrok2ApiBaseUrl(env.GROK2API_BASE_URL, env.GROK_WEB_BASE_URL),
    grok2api_admin_key: env.GROK2API_ADMIN_KEY || DEFAULT_GROK2API_ADMIN_KEY,
    api_capability: providerApiCapability("grok"),
  };
}

function webFallbackConfig(options = {}, env = process.env) {
  const rawTransport = String(options.transport ?? env.GROK_TRANSPORT ?? "web").trim().toLowerCase();
  return {
    provider: "grok-web",
    display_name: "Grok Web",
    auth_mode: "subscription_web",
    selected_route: "subscription_web",
    transport: "web",
    requested_transport: options.requestedTransport ?? "web",
    fallback_from: options.fallbackFrom ?? null,
    fallback_reason: options.fallbackReason ?? null,
    base_url: normalizeBaseUrl(env.GROK_WEB_BASE_URL),
    model: env.GROK_WEB_MODEL || DEFAULT_WEB_MODEL,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    doctor_timeout_ms: DEFAULT_DOCTOR_TIMEOUT_MS,
    chat_doctor_timeout_ms: DEFAULT_CHAT_DOCTOR_TIMEOUT_MS,
    tunnel_start_timeout_ms: DEFAULT_TUNNEL_START_TIMEOUT_MS,
    tunnel_cleanup_timeout_ms: DEFAULT_TUNNEL_CLEANUP_TIMEOUT_MS,
    max_prompt_chars: DEFAULT_MAX_PROMPT_CHARS,
    prompt_budget_env: "GROK_WEB_MAX_PROMPT_CHARS",
    default_model_env: "GROK_WEB_MODEL",
    timeout_env: "GROK_WEB_TIMEOUT_MS",
    legacy: rawTransport === "legacy" || rawTransport === "tunnel" || rawTransport === "grok-web",
    credential_ref: env.GROK_WEB_TUNNEL_API_KEY ? "GROK_WEB_TUNNEL_API_KEY" : null,
    credential_value: env.GROK_WEB_TUNNEL_API_KEY || null,
    grok2api_base_url: normalizeGrok2ApiBaseUrl(env.GROK2API_BASE_URL, env.GROK_WEB_BASE_URL),
    grok2api_admin_key: env.GROK2API_ADMIN_KEY || DEFAULT_GROK2API_ADMIN_KEY,
    api_capability: providerApiCapability("grok"),
  };
}

export function resolveGrokTransportMode(options = {}, env = process.env) {
  const raw = String(options.transport ?? env.GROK_TRANSPORT ?? "cli").trim().toLowerCase();
  const normalized = raw === "legacy" || raw === "tunnel" || raw === "grok-web" ? "web" : raw;
  if (!VALID_TRANSPORTS.has(normalized)) {
    throw new Error(`bad_args: unsupported Grok transport ${JSON.stringify(raw)}; use cli, web, or auto`);
  }
  return normalized;
}

export function resolveGrokConfig(options = {}, env = process.env) {
  const transport = resolveGrokTransportMode(options, env);
  if (transport === "web") return webConfig(options, env);
  if (transport === "auto") return cliConfig({ ...options, requestedTransport: "auto" }, env);
  return cliConfig({ ...options, requestedTransport: "cli" }, env);
}

export function resolveGrokFallbackConfig(options = {}, env = process.env) {
  const transport = resolveGrokTransportMode(options, env);
  if (transport === "web") return webFallbackConfig(options, env);
  return cliFallbackConfig({ ...options, requestedTransport: transport }, env);
}

export function webAutoFallbackConfig(options = {}, env = process.env, reason = null) {
  return webConfig({
    ...options,
    transport: "web",
    requestedTransport: "auto",
    fallbackFrom: "cli",
    fallbackReason: reason,
  }, env);
}

export function promptBudgetEnvName(config) {
  return config?.prompt_budget_env ?? null;
}

function sourceTransmissionBlocksFallback(value) {
  return value === true || value === "sent" || value === "may_be_sent";
}

export function canAutoFallbackFromCliExecution(config, execution) {
  if (config?.requested_transport !== "auto" || config?.transport !== "cli") return false;
  if (!execution || execution.exitCode === 0) return false;
  if (sourceTransmissionBlocksFallback(execution.source_sent)) return false;
  if (sourceTransmissionBlocksFallback(execution.payload_sent)) return false;
  if (execution.source_sent !== false && execution.payload_sent !== false) return false;
  return GROK_CLI_AUTO_FALLBACK_CODES.has(execution.parsed?.reason);
}

export function cliRequestDiagnosticsForFallback(execution) {
  const diagnostics = execution?.diagnostics ?? {};
  return {
    transport: "cli",
    error_code: execution?.parsed?.reason ?? null,
    model: diagnostics.model ?? null,
    grok_version: diagnostics.grok_version ?? null,
    default_model: diagnostics.default_model ?? null,
    logged_in: diagnostics.logged_in ?? null,
    model_ready: diagnostics.model_ready ?? null,
    exit_status: diagnostics.exit_status ?? null,
    exit_signal: diagnostics.exit_signal ?? null,
    stderr_head: diagnostics.stderr_head ?? null,
    parse_mode: diagnostics.parse_mode ?? null,
    source_free_parse_mode: diagnostics.source_free_parse_mode ?? null,
    source_free_prompt_cleanup: diagnostics.source_free_prompt_cleanup ?? null,
    source_free_grok_home_cleanup: diagnostics.source_free_grok_home_cleanup ?? null,
    prompt_chars: diagnostics.prompt_chars ?? null,
    configured_timeout_ms: diagnostics.configured_timeout_ms ?? null,
    max_turns: diagnostics.max_turns ?? null,
    prompt_cleanup: diagnostics.prompt_cleanup ?? null,
    neutral_cwd: diagnostics.neutral_cwd ?? null,
    neutral_cwd_cleanup: diagnostics.neutral_cwd_cleanup ?? null,
    grok_home_source: diagnostics.grok_home_source ?? null,
    grok_home_copied_files: diagnostics.grok_home_copied_files ?? [],
    grok_home_linked_files: diagnostics.grok_home_linked_files ?? [],
    grok_home_cleanup: diagnostics.grok_home_cleanup ?? null,
  };
}
