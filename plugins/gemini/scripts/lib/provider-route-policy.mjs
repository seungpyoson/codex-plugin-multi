import { createHash } from "node:crypto";

import { hasSubstantiveInvalidVerdictReason } from "./external-model-review-quality.mjs";

export const PROVIDER_POLICY_PROVIDERS = Object.freeze([
  "claude",
  "gemini",
  "kimi",
  "grok",
  "deepseek",
  "glm",
]);

export const PROVIDER_ROUTE_STEPS = Object.freeze([
  "subscription",
  "direct_api",
  "openrouter",
]);

export const PROVIDER_POLICY_DOMAINS = Object.freeze([
  Object.freeze({
    name: "route",
    required_fields: Object.freeze([
      "route_steps",
      "route_step",
      "selected_route",
      "fallback_reason",
      "auth_path",
      "billing_path",
    ]),
    shared_policy: true,
  }),
  Object.freeze({
    name: "packet",
    required_fields: Object.freeze([
      "source_bearing",
      "source_packet_budget_bytes",
      "selected_source_bytes",
      "source_packet_within_budget",
      "source_packet_action",
      "source_send_approval_required",
      "source_send_approval_state",
      "source_content_transmission",
      "resend_confirmation_required",
      "review_surface_changed",
    ]),
    shared_policy: true,
  }),
  Object.freeze({
    name: "readiness_auth",
    required_fields: Object.freeze([
      "auth_path",
      "auth_policy",
      "approval_scope",
      "source_send_approval_state",
    ]),
    shared_policy: true,
  }),
  Object.freeze({
    name: "status_lifecycle",
    required_fields: Object.freeze([
      "status",
      "started_at",
      "ended_at",
      "run_kind",
    ]),
    shared_policy: true,
  }),
  Object.freeze({
    name: "failure_taxonomy",
    required_fields: Object.freeze([
      "error_code",
      "error_cause",
      "error_summary",
    ]),
    shared_policy: true,
  }),
  Object.freeze({
    name: "suggested_action",
    required_fields: Object.freeze(["suggested_action"]),
    shared_policy: true,
  }),
  Object.freeze({
    name: "review_quality",
    required_fields: Object.freeze([
      "review_quality.failed_review_slot",
      "review_quality.semantic_failure_reasons",
    ]),
    shared_policy: true,
  }),
  Object.freeze({
    name: "audit",
    required_fields: Object.freeze([
      "rendered_prompt_hash",
      "selected_source",
      "scope_resolution",
    ]),
    shared_policy: true,
  }),
  Object.freeze({
    name: "docs",
    required_fields: Object.freeze([
      "EXTERNAL_MODEL_CONTRACT_VERSION",
      "generated_contract_docs",
    ]),
    shared_policy: true,
  }),
  Object.freeze({
    name: "sync",
    required_fields: Object.freeze([
      "packaged_copies",
      "sync_guard",
    ]),
    shared_policy: true,
  }),
]);

const ROUTE_MODES = new Set(["subscription", "api", "direct_api", "openrouter"]);
const APPROVAL_SCOPES = new Set(["session", "once"]);
const DEFAULT_SOURCE_PACKET_BUDGET_BYTES = 512 * 1024;
const SOURCE_SEND_BLOCKING_FAILURES = new Set([
  "timeout",
  "step_limit_exceeded",
  "usage_limited",
  "review_not_completed",
  "review_quality_failed",
  "invalid_verdict",
  "model_capacity",
]);
const SOURCE_RESUME_WITHOUT_RESEND_FAILURES = new Set([
  "step_limit_exceeded",
]);
const API_FALLBACK_REASONS = new Set([
  "explicit_api",
  "explicit_openrouter",
  "not_authed",
  "oauth_inference_rejected",
  "direct_api_not_supported",
  "direct_api_unavailable",
  "openrouter_not_supported",
  "subscription_not_supported",
  "subscription_unavailable",
  "usage_limited",
]);

export function buildProviderPolicyContract() {
  return {
    providers: [...PROVIDER_POLICY_PROVIDERS],
    route_steps: [...PROVIDER_ROUTE_STEPS],
    domains: PROVIDER_POLICY_DOMAINS.map((domain) => ({
      name: domain.name,
      required_fields: [...domain.required_fields],
      shared_policy: domain.shared_policy,
    })),
  };
}

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
    const message = `route mode must be subscription, api, direct_api, or openrouter; got ${JSON.stringify(route)}`;
    if (typeof fail === "function") {
      fail("bad_args", message);
      return null;
    }
    throw new Error(message);
  }
  return route === "direct_api" ? "api" : route;
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

export function sourcePacketPreviousAttemptFromJobRecord(record = null) {
  const manifest = record?.review_metadata?.audit_manifest ?? null;
  const selectedSource = manifest?.selected_source ?? null;
  if (!selectedSource) return null;
  return Object.freeze({
    status: record?.status ?? null,
    error_code: record?.error_code ?? manifest?.error_code ?? null,
    error_message: record?.error_message ?? null,
    review_quality: manifest?.review_quality ?? null,
    source_content_transmission:
      record?.external_review?.source_content_transmission ??
      manifest?.source_content_transmission ??
      null,
    selected_source: selectedSource,
  });
}

export function sourcePacketCanResumeWithoutResendFromJobRecord(record = null) {
  return sourcePacketCanResumeWithoutResendFromPreviousAttempt(
    sourcePacketPreviousAttemptFromJobRecord(record),
  );
}

export function sourcePacketCanResumeWithoutResendFromPreviousAttempt(previousAttempt = null) {
  return previousSourceWasSent(previousAttempt)
    && previousFailureAllowsResumeWithoutResend(previousAttempt);
}

export function sourcePacketPreviousAttemptForContinuation(record = null, runtimeOptions = null) {
  const recordAttempt = sourcePacketPreviousAttemptFromJobRecord(record);
  if (sourcePacketCanResumeWithoutResendFromPreviousAttempt(recordAttempt)) return recordAttempt;

  const runtimeAttempt = runtimeOptions?.previous_source_attempt;
  if (runtimeAttempt && typeof runtimeAttempt === "object" && !Array.isArray(runtimeAttempt)) {
    return runtimeAttempt;
  }

  return recordAttempt;
}

function apiCapability(providerCapabilities) {
  return providerCapabilities?.api ?? null;
}

function subscriptionCapability(providerCapabilities) {
  return providerCapabilities?.subscription ?? null;
}

function openRouterCapability(providerCapabilities) {
  return providerCapabilities?.openrouter ?? null;
}

function capabilityForRouteStep(providerCapabilities = {}, routeStep = null) {
  if (routeStep === "subscription") return subscriptionCapability(providerCapabilities);
  if (routeStep === "direct_api" || routeStep === "api") return apiCapability(providerCapabilities);
  if (routeStep === "openrouter") return openRouterCapability(providerCapabilities);
  return null;
}

function sourcePacketBudgetBytes(providerCapabilities = {}, routeStep = null) {
  const routeCapability = capabilityForRouteStep(providerCapabilities, routeStep);
  const configured = routeCapability?.source_packet?.max_bytes
    ?? providerCapabilities?.source_packet?.max_bytes
    ?? DEFAULT_SOURCE_PACKET_BUDGET_BYTES;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`source packet max_bytes must be a positive integer; got ${JSON.stringify(configured)}`);
  }
  return parsed;
}

function selectedSourceTotals(selectedSource = null) {
  const totals = selectedSource?.totals;
  return {
    files: Number.isSafeInteger(totals?.files) ? totals.files : 0,
    bytes: Number.isSafeInteger(totals?.bytes) ? totals.bytes : 0,
    lines: Number.isSafeInteger(totals?.lines) ? totals.lines : 0,
  };
}

function sourcePacketHash(selectedSource = null) {
  if (!selectedSource) return null;
  const files = Array.isArray(selectedSource.files) ? selectedSource.files : [];
  const normalized = {
    files: files.map((file) => ({
      path: file?.path ?? null,
      bytes: file?.bytes ?? null,
      lines: file?.lines ?? null,
      content_hash: file?.content_hash?.value ?? file?.content_hash ?? null,
    })),
    totals: selectedSourceTotals(selectedSource),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function previousSelectedSource(previousAttempt = null) {
  return previousAttempt?.selected_source ?? previousAttempt?.source_packet ?? null;
}

function previousSourceWasSent(previousAttempt = null) {
  const transmission = String(previousAttempt?.source_content_transmission ?? "");
  return previousAttempt?.source_sent === true
    || transmission === "sent"
    || transmission === "may_be_sent"
    || transmission === "sent_after_explicit_approval";
}

function previousFailureRequiresResendGate(previousAttempt = null) {
  if (!previousAttempt) return false;
  if (previousAttempt.status === "failed") return true;
  const errorCode = previousAttempt.error_code ?? previousAttempt.reason;
  return SOURCE_SEND_BLOCKING_FAILURES.has(errorCode);
}

function previousFailureAllowsResumeWithoutResend(previousAttempt = null) {
  const errorCode = previousAttempt?.error_code ?? previousAttempt?.reason ?? null;
  if (SOURCE_RESUME_WITHOUT_RESEND_FAILURES.has(errorCode)) return true;
  if (errorCode !== "review_not_completed") return false;
  return hasSubstantiveInvalidVerdictReason(previousReviewQualityReasons(previousAttempt));
}

function previousReviewQualityReasons(previousAttempt = null) {
  const directReasons =
    previousAttempt?.review_quality?.semantic_failure_reasons ??
    previousAttempt?.semantic_failure_reasons;
  if (Array.isArray(directReasons)) return directReasons;

  const message = previousAttempt?.error_message;
  if (typeof message !== "string") return [];
  const prefix = "review_quality_failed:";
  if (!message.startsWith(prefix)) return [];
  const reasonText = message.slice(prefix.length).trim();
  if (!reasonText) return [];
  return reasonText.split(",").map((reason) => reason.trim()).filter(Boolean);
}

function sourcePacketSuggestedAction(action, provider = null) {
  const target = provider ? `${provider} ` : "";
  if (action === "narrow_source_packet") {
    return `Do not send selected source. Narrow or shard the ${target}source packet before retrying.`;
  }
  if (action === "resend_confirmation_required") {
    return `Treat the previous ${target}slot as failed. Do not automatically resend selected source without explicit resend confirmation or a narrowed source packet.`;
  }
  if (action === "resume_without_source_resend") {
    return `Resume the previous ${target}session without resending selected source.`;
  }
  if (action === "send_narrowed_source_packet") {
    return "Proceed with the narrowed source packet and record the review-surface change.";
  }
  if (action === "send_after_resend_confirmation") {
    return "Proceed after explicit resend confirmation and record the approval tuple.";
  }
  return null;
}

export function evaluateSourcePacketPolicy({
  provider = null,
  mode = null,
  routeStep = null,
  providerCapabilities = {},
  selectedSource = null,
  sourceBearing = false,
  previousAttempt = null,
  resendConfirmationApproved = false,
  resumeWithoutSourceResend = false,
} = {}) {
  const totals = selectedSourceTotals(selectedSource);
  const packetBudgetBytes = sourcePacketBudgetBytes(providerCapabilities, routeStep);
  const effectiveSourceBearing = sourceBearing === true || totals.bytes > 0 || totals.files > 0;
  const sourcePacketWithinBudget = totals.bytes <= packetBudgetBytes;
  const previousSource = previousSelectedSource(previousAttempt);
  const previousTotals = selectedSourceTotals(previousSource);
  const previousHash = sourcePacketHash(previousSource);
  const currentHash = sourcePacketHash(selectedSource);
  const reviewSurfaceChanged = previousHash !== null && currentHash !== null && previousHash !== currentHash;
  const narrowedSourcePacket = previousSource !== null && totals.bytes < previousTotals.bytes;

  const base = {
    provider,
    mode,
    route_step: routeStep,
    source_bearing: effectiveSourceBearing,
    source_packet_budget_bytes: packetBudgetBytes,
    selected_source_bytes: totals.bytes,
    source_packet_within_budget: sourcePacketWithinBudget,
    resend_confirmation_required: false,
    resume_without_source_resend: resumeWithoutSourceResend === true,
    review_surface_changed: reviewSurfaceChanged,
    source_packet_policy_error_code: null,
    suggested_action: null,
  };

  if (!effectiveSourceBearing) {
    return Object.freeze({
      ...base,
      source_send_allowed: true,
      source_packet_action: "not_source_bearing",
      source_content_transmission: "not_sent",
    });
  }

  if (!sourcePacketWithinBudget) {
    const action = "narrow_source_packet";
    return Object.freeze({
      ...base,
      source_send_allowed: false,
      source_packet_action: action,
      source_content_transmission: "not_sent",
      source_packet_policy_error_code: "source_packet_too_large",
      suggested_action: sourcePacketSuggestedAction(action, provider),
    });
  }

  if (
    previousSourceWasSent(previousAttempt)
    && previousFailureRequiresResendGate(previousAttempt)
    && previousFailureAllowsResumeWithoutResend(previousAttempt)
    && resumeWithoutSourceResend
    && totals.bytes === 0
    && totals.files === 0
  ) {
    const action = "resume_without_source_resend";
    return Object.freeze({
      ...base,
      source_send_allowed: true,
      source_packet_action: action,
      source_content_transmission: "not_sent",
      suggested_action: sourcePacketSuggestedAction(action, provider),
    });
  }

  if (
    previousSourceWasSent(previousAttempt)
    && previousFailureRequiresResendGate(previousAttempt)
    && !resendConfirmationApproved
    && !narrowedSourcePacket
  ) {
    const action = "resend_confirmation_required";
    return Object.freeze({
      ...base,
      source_send_allowed: false,
      source_packet_action: action,
      source_content_transmission: "not_sent",
      resend_confirmation_required: true,
      source_packet_policy_error_code: action,
      suggested_action: sourcePacketSuggestedAction(action, provider),
    });
  }

  if (narrowedSourcePacket) {
    const action = "send_narrowed_source_packet";
    return Object.freeze({
      ...base,
      source_send_allowed: true,
      source_packet_action: action,
      source_content_transmission: "may_be_sent",
      suggested_action: sourcePacketSuggestedAction(action, provider),
    });
  }

  if (resendConfirmationApproved) {
    const action = "send_after_resend_confirmation";
    return Object.freeze({
      ...base,
      source_send_allowed: true,
      source_packet_action: action,
      source_content_transmission: "may_be_sent",
      suggested_action: sourcePacketSuggestedAction(action, provider),
    });
  }

  return Object.freeze({
    ...base,
    source_send_allowed: true,
    source_packet_action: "send",
    source_content_transmission: "may_be_sent",
  });
}

function apiFallbackReason({ requestedRoute, fallbackReason, hasSubscription }) {
  const reason = fallbackReason ?? (hasSubscription ? "explicit_api" : "subscription_not_supported");
  if (!API_FALLBACK_REASONS.has(reason)) {
    throw new Error(`unsupported route fallback reason ${JSON.stringify(reason)}`);
  }
  return reason;
}

function openRouterFallbackReason({ requestedRoute, fallbackReason, hasApi }) {
  const reason = fallbackReason ?? (requestedRoute === "openrouter"
    ? "explicit_openrouter"
    : (hasApi ? "direct_api_unavailable" : "direct_api_not_supported"));
  if (!API_FALLBACK_REASONS.has(reason)) {
    throw new Error(`unsupported route fallback reason ${JSON.stringify(reason)}`);
  }
  return reason;
}

function routeStepForMode(routeMode) {
  return routeMode === "api" ? "direct_api" : routeMode;
}

function sourceApprovalState({ routeStep, sourceBearing, sourceSendApproved }) {
  if (routeStep === "subscription" || !sourceBearing) {
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

function stepSupported(step, capabilities) {
  if (step === "subscription") return !!capabilities.subscription;
  if (step === "direct_api") return !!capabilities.api;
  if (step === "openrouter") return !!capabilities.openrouter;
  return false;
}

function selectedStepIndex(selectedStep) {
  return PROVIDER_ROUTE_STEPS.indexOf(selectedStep);
}

function routeStepSkippedReason({ step, supported, selected, requestedStep, selectedStep }) {
  if (selected) return null;
  if (!supported) return "unsupported";
  if (selectedStepIndex(step) < selectedStepIndex(requestedStep)) return "not_requested";
  if (selectedStepIndex(step) > selectedStepIndex(selectedStep)) return "not_needed";
  return "not_selected";
}

function unsupportedFallbackReason(step, selectedStep) {
  if (step === "subscription" && selectedStep !== "subscription") return "subscription_not_supported";
  if (step === "direct_api" && selectedStep === "openrouter") return "direct_api_not_supported";
  return null;
}

function routeStepFallbackReason({ step, selected, selectedFallbackReason, supported, selectedStep, requestedStep }) {
  if (selected) return selectedFallbackReason;
  if (!supported) return unsupportedFallbackReason(step, selectedStep);
  if (selectedStepIndex(step) < selectedStepIndex(requestedStep)) return selectedFallbackReason;
  return null;
}

function buildRouteSteps({ capabilities, requestedStep, selectedStep, selectedFallbackReason }) {
  return PROVIDER_ROUTE_STEPS.map((step) => {
    const supported = stepSupported(step, capabilities);
    const selected = step === selectedStep;
    return {
      route: step,
      supported,
      attempted: true,
      selected,
      skipped_reason: routeStepSkippedReason({ step, supported, selected, requestedStep, selectedStep }),
      fallback_reason: routeStepFallbackReason({
        step,
        selected,
        selectedFallbackReason,
        supported,
        selectedStep,
        requestedStep,
      }),
    };
  });
}

function selectRouteMode({ requested, subscription, api, openrouter }) {
  if (requested === "subscription") {
    if (subscription) return "subscription";
    if (api) return "api";
    if (openrouter) return "openrouter";
  }
  if (requested === "api") {
    if (api) return "api";
    if (openrouter) return "openrouter";
  }
  if (requested === "openrouter" && openrouter) return "openrouter";
  return null;
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
  const openrouter = openRouterCapability(providerCapabilities);
  const hasSubscription = !!subscription;
  const hasApi = !!api;
  const capabilities = { subscription, api, openrouter };
  const routeMode = selectRouteMode({ requested, subscription, api, openrouter });
  if (!routeMode) {
    throw new Error(`route ${JSON.stringify(requested)} requested but provider has no supported capability for the shared ladder`);
  }
  const routeStep = routeStepForMode(routeMode);

  if (routeMode === "subscription") {
    if (!subscription) throw new Error("subscription route requested but provider has no subscription capability");
    const apiEnv = [
      ...presentEnvNames(providerEnvNames(api), env),
      ...presentEnvNames(providerEnvNames(openrouter), env),
    ];
    return {
      route_mode: "subscription",
      route_step: routeStep,
      selected_route: subscription.auth_path ?? `subscription_${subscription.kind ?? "unknown"}`,
      auth_path: subscription.auth_path ?? `subscription_${subscription.kind ?? "unknown"}`,
      billing_path: null,
      fallback_reason: null,
      allowed_env_credentials: [],
      ignored_env_credentials: apiEnv,
      ...sourceApprovalState({ routeStep, sourceBearing, sourceSendApproved }),
      route_steps: buildRouteSteps({
        capabilities,
        requestedStep: routeStepForMode(requested),
        selectedStep: routeStep,
        selectedFallbackReason: null,
      }),
    };
  }

  if (routeMode === "api") {
    if (!api) throw new Error("API route requested but provider has no API capability");
    const apiEnv = presentEnvNames(providerEnvNames(api), env);
    const openRouterEnv = presentEnvNames(providerEnvNames(openrouter), env);
    const authPath = apiEnv.length > 0 ? (api.auth_path ?? "api_key_env") : "api_key_env_missing";
    const routeFallbackReason = apiFallbackReason({ requestedRoute: requested, fallbackReason, hasSubscription });
    return {
      route_mode: "api",
      route_step: routeStep,
      selected_route: api.kind ?? "direct_api",
      auth_path: authPath,
      billing_path: api.billing_path ?? null,
      fallback_reason: routeFallbackReason,
      allowed_env_credentials: apiEnv,
      ignored_env_credentials: openRouterEnv,
      ...sourceApprovalState({ routeStep, sourceBearing, sourceSendApproved }),
      route_steps: buildRouteSteps({
        capabilities,
        requestedStep: routeStepForMode(requested),
        selectedStep: routeStep,
        selectedFallbackReason: routeFallbackReason,
      }),
    };
  }

  const openRouterEnv = presentEnvNames(providerEnvNames(openrouter), env);
  const authPath = openRouterEnv.length > 0
    ? (openrouter.auth_path ?? "openrouter_api_key_env")
    : "openrouter_api_key_env_missing";
  const routeFallbackReason = openRouterFallbackReason({ requestedRoute: requested, fallbackReason, hasApi });
  return {
    route_mode: "openrouter",
    route_step: routeStep,
    selected_route: openrouter.kind ?? "openrouter",
    auth_path: authPath,
    billing_path: openrouter.billing_path ?? null,
    fallback_reason: routeFallbackReason,
    allowed_env_credentials: openRouterEnv,
    ignored_env_credentials: [],
    ...sourceApprovalState({ routeStep, sourceBearing, sourceSendApproved }),
    route_steps: buildRouteSteps({
      capabilities,
      requestedStep: routeStepForMode(requested),
      selectedStep: routeStep,
      selectedFallbackReason: routeFallbackReason,
    }),
  };
}
