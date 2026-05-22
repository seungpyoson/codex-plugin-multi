const ROUTE_MODES = new Set(["subscription", "api"]);
const APPROVAL_SCOPES = new Set(["session", "once"]);
const API_FALLBACK_REASONS = new Set([
  "explicit_api",
  "not_authed",
  "oauth_inference_rejected",
  "subscription_not_supported",
  "subscription_unavailable",
  "usage_limited",
]);

function providerEnvNames(capability = {}) {
  if (!capability || typeof capability !== "object") return [];
  return Array.isArray(capability.credential_env_names) ? capability.credential_env_names : [];
}

function presentEnvNames(names, env = process.env) {
  return names.filter((name) => env[name]);
}

function normalizeRequestedRoute(requestedRoute, fail) {
  const route = requestedRoute ?? "subscription";
  if (!ROUTE_MODES.has(route)) {
    const message = `route mode must be subscription or api; got ${JSON.stringify(route)}`;
    if (typeof fail === "function") {
      fail("bad_args", message);
      return null;
    }
    throw new Error(message);
  }
  return route;
}

export function normalizeApprovalScope(approvalScope = "session", fail = null) {
  const scope = approvalScope ?? "session";
  if (!APPROVAL_SCOPES.has(scope)) {
    const message = `approval scope must be session or once; got ${JSON.stringify(scope)}`;
    if (typeof fail === "function") {
      fail("bad_args", message);
      return null;
    }
    throw new Error(message);
  }
  return scope;
}

function apiCapability(providerCapabilities) {
  return providerCapabilities?.api ?? null;
}

function subscriptionCapability(providerCapabilities) {
  return providerCapabilities?.subscription ?? null;
}

function apiFallbackReason({ requestedRoute, fallbackReason, hasSubscription }) {
  const reason = fallbackReason ?? (hasSubscription ? "explicit_api" : "subscription_not_supported");
  if (!API_FALLBACK_REASONS.has(reason)) {
    throw new Error(`unsupported API fallback reason ${JSON.stringify(reason)}`);
  }
  return reason;
}

function sourceApprovalState({ routeMode, sourceBearing, sourceSendApproved }) {
  if (routeMode !== "api" || !sourceBearing) {
    return {
      source_send_approval_required: false,
      source_send_approval_state: "not_required",
    };
  }
  return {
    source_send_approval_required: true,
    source_send_approval_state: sourceSendApproved ? "approved" : "required",
  };
}

export function selectProviderRoute({
  requestedRoute,
  fallbackReason = null,
  providerCapabilities,
  env = process.env,
  sourceBearing = false,
  sourceSendApproved = false,
  fail = null,
} = {}) {
  const requested = normalizeRequestedRoute(requestedRoute, fail);
  if (requested === null) return null;

  const subscription = subscriptionCapability(providerCapabilities);
  const api = apiCapability(providerCapabilities);
  const hasSubscription = !!subscription;
  const routeMode = requested === "subscription" && !hasSubscription ? "api" : requested;

  if (routeMode === "subscription") {
    if (!subscription) throw new Error("subscription route requested but provider has no subscription capability");
    const apiEnv = presentEnvNames(providerEnvNames(api), env);
    return {
      route_mode: "subscription",
      selected_route: subscription.auth_path ?? `subscription_${subscription.kind ?? "unknown"}`,
      auth_path: subscription.auth_path ?? `subscription_${subscription.kind ?? "unknown"}`,
      billing_path: null,
      fallback_reason: null,
      allowed_env_credentials: [],
      ignored_env_credentials: apiEnv,
      ...sourceApprovalState({ routeMode: "subscription", sourceBearing, sourceSendApproved }),
    };
  }

  if (!api) throw new Error("API route requested but provider has no API capability");
  const apiEnv = presentEnvNames(providerEnvNames(api), env);
  const authPath = apiEnv.length > 0 ? (api.auth_path ?? "api_key_env") : "api_key_env_missing";
  return {
    route_mode: "api",
    selected_route: api.kind ?? "direct_api",
    auth_path: authPath,
    billing_path: api.billing_path ?? null,
    fallback_reason: apiFallbackReason({ requestedRoute: requested, fallbackReason, hasSubscription }),
    allowed_env_credentials: apiEnv,
    ignored_env_credentials: [],
    ...sourceApprovalState({ routeMode: "api", sourceBearing, sourceSendApproved }),
  };
}
