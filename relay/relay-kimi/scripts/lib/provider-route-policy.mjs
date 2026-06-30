import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasSubstantiveInvalidVerdictReason } from "./external-model-review-quality.mjs";

export const PROVIDER_POLICY_PROVIDERS = Object.freeze([
  "claude",
  "gemini",
  "kimi",
  "agy",
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
      "source_packet_override_approved",
      "source_packet_override_source",
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
    name: "review_slot",
    required_fields: Object.freeze([
      "review_slot.slot_id",
      "review_slot.attempt_id",
      "review_slot.reviewed_head_sha",
      "review_slot.retry_fingerprint",
      "review_slot.retry_count",
      "review_slot.retry_disposition_required",
      "review_slot.source_state",
      "review_slot.verdict",
      "review_slot.failed_slot_reason",
      "review_slot.disposition",
      "review_slot.not_counted_reason",
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

function freezeConcurrencyFacts(table) {
  for (const routes of Object.values(table)) {
    for (const fact of Object.values(routes)) Object.freeze(fact);
    Object.freeze(routes);
  }
  return Object.freeze(table);
}

export const CONCURRENCY_FACTS = freezeConcurrencyFacts({
  claude: {
    subscription: { category: "shared_state", limit: 1 },
  },
  gemini: {
    subscription: { category: "shared_state", limit: 1 },
  },
  kimi: {
    subscription: { category: "shared_state", limit: 1 },
  },
  agy: {
    subscription: { category: "shared_state", limit: 1 },
  },
  grok: {
    subscription: { category: "shared_state", limit: 1 },
  },
  "grok-web": {
    subscription_web: { category: "shared_state", limit: 1 },
  },
  deepseek: {
    // Stateless direct API (pure fetch, no shared local state): bounded concurrency at the
    // D2 default of 4. The env cap can only LOWER it (Math.min in resolveConcurrencyAdmission).
    direct_api: { category: "stateless", limit: 4, limit_env: "RELAY_DEEPSEEK_CONCURRENCY_LIMIT" },
  },
  glm: {
    direct_api: { category: "stateless", limit: 4, limit_env: "RELAY_GLM_CONCURRENCY_LIMIT" },
  },
  custom: {
    // A custom user-defined endpoint has unknown rate-limit/capacity, so it stays single-flight
    // (limit 1) until a specific endpoint is proven; the env cap can only lower, never raise.
    direct_api: { category: "stateless", limit: 1, limit_env: "RELAY_CUSTOM_DIRECT_API_CONCURRENCY_LIMIT" },
  },
});

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
const SOURCE_SENT_PACKET_RECOVERY_FAILURES = new Set([
  "review_not_completed",
  "provider_unavailable",
  "stale_active_job",
  "step_limit_exceeded",
  "timeout",
]);
const SOURCE_SENT_PACKET_RESUME_FAILURES = new Set([
  "review_not_completed",
  "step_limit_exceeded",
]);
const REVIEW_SLOT_DISPOSITIONS = new Set([
  "none",
  "retry",
  "split",
  "switch_provider",
  "waive",
  "override",
]);
const REVIEW_SLOT_ESCAPE_DISPOSITIONS = new Set([
  "waive",
  "override",
]);
const REVIEW_SLOT_ALLOWED_FIELDS = Object.freeze([
  "slot_id",
  "attempt_id",
  "parent_attempt_id",
  "reviewed_head_sha",
  "retry_fingerprint",
  "retry_count",
  "retry_disposition_required",
  "request_settings_hash",
  "source_state",
  "verdict",
  "failed_slot_reason",
  "disposition",
  "not_counted_reason",
  "waiver_artifact",
  "override_artifact",
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

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function positiveIntegerEnv(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!/^[1-9]\d*$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return positiveInteger(parsed) ? parsed : null;
}

function requiredNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`concurrency admission ${name} is required`);
  }
  return value;
}

function defaultProviderWorkloadLockRoot(env = process.env) {
  const xdgStateHome = typeof env?.XDG_STATE_HOME === "string" && env.XDG_STATE_HOME.trim() !== ""
    ? env.XDG_STATE_HOME
    : null;
  if (xdgStateHome) return join(xdgStateHome, "relay", "locks", "v2");
  const uid = process.getuid?.();
  const userSegment = Number.isSafeInteger(uid) && uid >= 0 ? `relay-locks-v2-${uid}` : "relay-locks-v2-user";
  return join(tmpdir(), userSegment);
}

function providerWorkloadLockRoot(category, env = process.env) {
  const override = typeof env?.RELAY_PROVIDER_WORKLOAD_LOCK_DIR === "string"
    && env.RELAY_PROVIDER_WORKLOAD_LOCK_DIR.trim() !== ""
    ? env.RELAY_PROVIDER_WORKLOAD_LOCK_DIR
    : null;
  if (override && (category === "stateless" || env?.RELAY_WORKLOAD_TEST_MODE)) return override;
  return defaultProviderWorkloadLockRoot(env);
}

function sharedStateConcurrencyKey(sharedStateIdentity) {
  if (typeof sharedStateIdentity !== "string" || sharedStateIdentity.trim() === "") {
    throw new Error("shared_state identity is required for concurrency admission");
  }

  let stats;
  try {
    stats = statSync(sharedStateIdentity);
  } catch (error) {
    const reason = error?.message ? `: ${error.message}` : "";
    throw new Error(`shared_state identity cannot be resolved${reason}`);
  }

  if (!stats.isDirectory()) {
    throw new Error("shared_state identity must resolve to a directory");
  }

  return createHash("sha256").update(`${stats.dev}:${stats.ino}`).digest("hex");
}

function sharedStateStringConcurrencyKey(identityString) {
  if (typeof identityString !== "string" || identityString.trim() === "") return null;
  return createHash("sha256").update(identityString).digest("hex");
}

export function resolveConcurrencyAdmission({
  category,
  declaredLimit = null,
  limit = null,
  limitEnv = null,
  limit_env: limitEnvSnake = null,
  sharedStateIdentity = null,
  identityString = null,
  provider = null,
  route = null,
  env = process.env,
} = {}) {
  const resolvedDeclaredLimit = declaredLimit ?? limit;
  const resolvedLimitEnv = limitEnv ?? limitEnvSnake;

  if (category === "shared_state") {
    if (!positiveInteger(resolvedDeclaredLimit)) {
      throw new Error("shared_state concurrency limit must be a positive integer");
    }
    if (resolvedDeclaredLimit > 1) {
      throw new Error("shared_state concurrency limit greater than 1 is unrepresentable");
    }
    return Object.freeze({
      concurrencyKey: sharedStateStringConcurrencyKey(identityString) ?? sharedStateConcurrencyKey(sharedStateIdentity),
      limit: 1,
      lockRoot: providerWorkloadLockRoot(category, env),
    });
  }

  if (category === "stateless") {
    if (!positiveInteger(resolvedDeclaredLimit)) {
      throw new Error("stateless concurrency limit must be a positive integer");
    }
    const providerKey = requiredNonEmptyString(provider, "provider");
    const routeKey = requiredNonEmptyString(route, "route");
    const envCap = resolvedLimitEnv ? positiveIntegerEnv(env?.[resolvedLimitEnv]) : null;
    return Object.freeze({
      concurrencyKey: `${providerKey}.${routeKey}`,
      limit: Math.min(resolvedDeclaredLimit, envCap ?? resolvedDeclaredLimit),
      lockRoot: providerWorkloadLockRoot(category, env),
    });
  }

  throw new Error(`concurrency admission category is required and must be shared_state or stateless; got ${JSON.stringify(category)}`);
}

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
    attempt_id: record?.job_id ?? record?.id ?? null,
    status: record?.status ?? null,
    error_code: record?.error_code ?? manifest?.error_code ?? null,
    error_message: record?.error_message ?? null,
    started_at: record?.started_at ?? record?.startedAt ?? null,
    review_quality: manifest?.review_quality ?? null,
    review_slot: manifest?.review_slot ?? record?.external_review?.review_slot ?? null,
    source_content_transmission:
      record?.external_review?.source_content_transmission ??
      manifest?.source_content_transmission ??
      null,
    selected_source: selectedSource,
  });
}

export function latestSourcePacketPreviousAttempt(priorAttempts = []) {
  if (!Array.isArray(priorAttempts)) return null;
  let latest = null;
  let latestIndex = -1;
  for (let index = 0; index < priorAttempts.length; index += 1) {
    const attempt = priorAttempts[index];
    if (!previousSelectedSource(attempt)) continue;
    if (!latest) {
      latest = attempt;
      latestIndex = index;
      continue;
    }
    const attemptStartedAt = typeof attempt?.started_at === "string" ? attempt.started_at : "";
    const latestStartedAt = typeof latest?.started_at === "string" ? latest.started_at : "";
    if (attemptStartedAt && latestStartedAt) {
      const timeOrder = attemptStartedAt.localeCompare(latestStartedAt);
      if (timeOrder > 0) {
        latest = attempt;
        latestIndex = index;
      } else if (timeOrder === 0) {
        const attemptId = String(attempt?.attempt_id ?? attempt?.job_id ?? "");
        const latestId = String(latest?.attempt_id ?? latest?.job_id ?? "");
        if (attemptId.localeCompare(latestId) > 0) {
          latest = attempt;
          latestIndex = index;
        }
      }
      continue;
    }
    if (attemptStartedAt && !latestStartedAt) {
      latest = attempt;
      latestIndex = index;
      continue;
    }
    if (!attemptStartedAt && !latestStartedAt && index > latestIndex) {
      latest = attempt;
      latestIndex = index;
    }
  }
  return latest;
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

function renderedPromptTransportCapability(providerCapabilities = {}, routeStep = null) {
  const routeCapability = capabilityForRouteStep(providerCapabilities, routeStep);
  return routeCapability?.rendered_prompt_transport
    ?? providerCapabilities?.rendered_prompt_transport
    ?? null;
}

function renderedPromptTransportBudgetBytes(providerCapabilities = {}, routeStep = null) {
  const configured = renderedPromptTransportCapability(providerCapabilities, routeStep)?.max_bytes;
  if (configured == null) return null;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`rendered prompt transport max_bytes must be a positive integer; got ${JSON.stringify(configured)}`);
  }
  return parsed;
}

function sourcePacketResumeWithoutResendSupported(providerCapabilities = {}, routeStep = null) {
  const routeCapability = capabilityForRouteStep(providerCapabilities, routeStep);
  const configured = routeCapability?.source_packet?.resume_without_resend_supported
    ?? providerCapabilities?.source_packet?.resume_without_resend_supported
    ?? true;
  return configured !== false;
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

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hashEnvelope(value) {
  return Object.freeze({
    algorithm: "sha256",
    value: hashJson(value),
  });
}

function hashValue(value) {
  if (typeof value === "string" && value.length > 0) return value;
  if (value && typeof value === "object" && typeof value.value === "string") return value.value;
  return null;
}

function canonicalScopePaths(paths = null) {
  if (!Array.isArray(paths)) return null;
  return Object.freeze(paths.map(String).sort((left, right) => left.localeCompare(right)));
}

function canonicalScopePathHmacs(hmacs = null) {
  if (!Array.isArray(hmacs)) return null;
  return Object.freeze(hmacs.map(String).sort((left, right) => left.localeCompare(right)));
}

function normalizedDisposition(value) {
  const disposition = String(value ?? "none");
  return REVIEW_SLOT_DISPOSITIONS.has(disposition) ? disposition : "none";
}

function artifactRef(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\0")) return null;
  if (/^[A-Za-z]:/.test(trimmed)) return null;
  if (trimmed.split(/[\\/]+/).includes("..")) return null;
  return trimmed;
}

export function reviewSlotRequestSettingsHash(request = {}) {
  return hashEnvelope({
    model: request.model ?? null,
    timeout_ms: request.timeoutMs ?? request.timeout_ms ?? null,
    max_tokens: request.maxTokens ?? request.max_tokens ?? null,
    max_steps_per_turn: request.maxStepsPerTurn ?? request.max_steps_per_turn ?? null,
    temperature: request.temperature ?? null,
    stream: request.stream ?? null,
  });
}

export function reviewSlotRetryFingerprint({
  provider = null,
  mode = null,
  renderedPromptHash = null,
  promptHash = null,
  selectedSource = null,
  reviewedHeadSha = null,
  routeStep = null,
  scope = {},
} = {}) {
  const ingredientsInput = {
    provider: provider ?? null,
    mode: mode ?? null,
    rendered_prompt_hash: hashValue(renderedPromptHash ?? promptHash),
    selected_source_hash: sourcePacketHash(selectedSource),
    selected_source_totals: selectedSourceTotals(selectedSource),
    reviewed_head_sha: reviewedHeadSha ?? null,
    route_step: routeStep ?? null,
    scope_name: scope.name ?? scope.scope ?? null,
    scope_base: scope.base ?? scope.scope_base ?? null,
    scope_paths: canonicalScopePaths(scope.paths ?? scope.scope_paths ?? null),
  };
  const scopePathHmacs = canonicalScopePathHmacs(
    scope.path_hmacs ?? scope.scope_path_hmacs ?? scope.hmacs ?? null,
  );
  if (scopePathHmacs !== null) ingredientsInput.scope_path_hmacs = scopePathHmacs;
  const ingredients = Object.freeze(ingredientsInput);
  return Object.freeze({
    algorithm: "sha256",
    value: hashJson(ingredients),
    ingredients,
  });
}

function canonicalScopeResolution(scopeResolution = {}) {
  const input = scopeResolution ?? {};
  const payload = {
    scope: input.scope ?? input.name ?? null,
    scope_base: input.scope_base ?? input.base ?? null,
    scope_paths: canonicalScopePaths(input.scope_paths ?? input.paths ?? null),
    reason: input.reason ?? null,
  };
  const scopePathHmacs = canonicalScopePathHmacs(
    input.scope_path_hmacs ?? input.path_hmacs ?? input.hmacs ?? null,
  );
  if (scopePathHmacs !== null) payload.scope_path_hmacs = scopePathHmacs;
  return Object.freeze(payload);
}

export function sourceSendApprovalTupleFingerprint({
  provider = null,
  mode = null,
  selectedSource = null,
  sourcePacket = null,
  renderedPromptHash = null,
  promptHash = null,
  scopeResolution = null,
  requestSettings = null,
  request = null,
  requestSettingsHash = null,
  authPath = null,
  billingPath = null,
  selectedRoute = null,
  routeStep = null,
  routeSteps = null,
  fallbackReason = null,
  approvalScope = "session",
} = {}) {
  const source = selectedSource ?? sourcePacket;
  const normalizedScopeResolution = canonicalScopeResolution(scopeResolution ?? {});
  const requestHash = hashValue(requestSettingsHash)
    ?? reviewSlotRequestSettingsHash(requestSettings ?? request ?? {}).value;
  const ingredients = Object.freeze({
    provider: provider ?? null,
    mode: mode ?? null,
    selected_source_hash: sourcePacketHash(source),
    selected_source_totals: selectedSourceTotals(source),
    rendered_prompt_hash: hashValue(renderedPromptHash ?? promptHash),
    scope_resolution_hash: hashJson(normalizedScopeResolution),
    request_settings_hash: requestHash,
    auth_path: authPath ?? null,
    billing_path_hash: billingPath == null ? null : hashJson(billingPath),
    selected_route: selectedRoute ?? null,
    route_step: routeStep ?? null,
    route_steps_hash: routeSteps == null ? null : hashJson(routeSteps),
    fallback_reason: fallbackReason ?? null,
    approval_scope: normalizeApprovalScope(approvalScope),
  });
  return Object.freeze({
    algorithm: "sha256",
    value: hashJson(ingredients),
    ingredients,
  });
}

export function sourceSendApprovalProofMatches({ approved = null, current = null } = {}) {
  const approvedHash = hashValue(approved);
  const currentHash = hashValue(current);
  return approvedHash !== null && currentHash !== null && approvedHash === currentHash;
}

function retryFingerprintForAttempt(attempt = null) {
  return hashValue(attempt?.retry_fingerprint)
    ?? hashValue(attempt?.review_slot?.retry_fingerprint)
    ?? hashValue(attempt?.review_metadata?.audit_manifest?.review_slot?.retry_fingerprint)
    ?? null;
}

function retryCountableAttempt(attempt = null) {
  const nestedSlot =
    attempt?.review_slot ??
    attempt?.review_metadata?.audit_manifest?.review_slot ??
    attempt;
  const verdict = String(nestedSlot?.verdict ?? "").toLowerCase();
  if (verdict === "approved" || verdict === "approve") return false;
  if (nestedSlot?.source_state === "not_sent") return false;
  const reason = nestedSlot?.not_counted_reason;
  return reason !== "source_not_sent" && reason !== "stale_head";
}

function retryCountContribution(attempt = null, fingerprint = null) {
  if (!fingerprint || retryFingerprintForAttempt(attempt) !== fingerprint) {
    return { flat: 0, accumulated: 0 };
  }
  const nestedSlot =
    attempt?.review_slot ??
    attempt?.review_metadata?.audit_manifest?.review_slot ??
    attempt;
  if (!retryCountableAttempt(nestedSlot)) {
    return { flat: 0, accumulated: 0 };
  }
  const priorCount = nestedSlot?.retry_count;
  if (Number.isSafeInteger(priorCount) && priorCount > 0) {
    return { flat: 0, accumulated: priorCount + 1 };
  }
  return { flat: 1, accumulated: 0 };
}

function retryCountForAttempts(attempts = [], fingerprint = null) {
  let flatCount = 0;
  let accumulatedCount = 0;
  for (const attempt of attempts) {
    const contribution = retryCountContribution(attempt, fingerprint);
    flatCount += contribution.flat;
    accumulatedCount = Math.max(accumulatedCount, contribution.accumulated);
  }
  return Math.max(flatCount, accumulatedCount);
}

export function evaluateReviewSlotRetryPolicy({
  retryFingerprint = null,
  priorAttempts = [],
  disposition = "none",
  waiverArtifact = null,
  overrideArtifact = null,
} = {}) {
  const fingerprint = hashValue(retryFingerprint);
  const attempts = Array.isArray(priorAttempts) ? priorAttempts : [];
  const retryCount = fingerprint ? retryCountForAttempts(attempts, fingerprint) : 0;
  const normalized = normalizedDisposition(disposition);
  const hasWaiverArtifact = artifactRef(waiverArtifact) !== null;
  const hasOverrideArtifact = artifactRef(overrideArtifact) !== null;
  const hasEscapeDisposition = REVIEW_SLOT_ESCAPE_DISPOSITIONS.has(normalized)
    && (normalized !== "waive" || hasWaiverArtifact)
    && (normalized !== "override" || hasOverrideArtifact);
  const retryDispositionRequired = retryCount >= 1;
  let allowed = true;
  let reason = null;
  if (normalized === "waive" && !hasWaiverArtifact) {
    allowed = false;
    reason = "review_slot_waiver_artifact_required";
  } else if (normalized === "override" && !hasOverrideArtifact) {
    allowed = false;
    reason = "review_slot_override_artifact_required";
  } else if (retryCount >= 2 && normalized === "retry") {
    allowed = false;
    reason = "retry_disposition_not_valid_for_third_attempt";
  } else if (retryCount >= 2 && !hasEscapeDisposition) {
    allowed = false;
    reason = "third_same_packet_retry_requires_disposition";
  } else if (retryCount >= 1 && normalized === "none") {
    allowed = false;
    reason = "review_slot_disposition_required";
  }
  return Object.freeze({
    retry_fingerprint: fingerprint,
    retry_count: retryCount,
    retry_disposition_required: retryDispositionRequired,
    disposition: normalized,
    slot_retry_allowed: allowed,
    source_send_allowed: allowed,
    fail_closed_reason: reason,
  });
}

function resultVerdict(result = "") {
  const match = /\bVerdict:\s*(APPROVE|REQUEST[ _]CHANGES|FAIL|REJECT)\b/i.exec(String(result ?? ""));
  if (!match) return null;
  const normalized = match[1].toLowerCase().replace(/\s+/g, "_");
  if (normalized === "approve") return "approved";
  if (normalized === "request_changes") return "request_changes";
  return "failed_slot";
}

function failedSlotReason({ verdict, status, errorCode, reviewQuality }) {
  if (verdict === "timeout") return "timeout";
  if (verdict === "missing") return "missing_verdict";
  if (verdict !== "failed_slot") return null;
  if (errorCode) return String(errorCode);
  const reasons = reviewQuality?.semantic_failure_reasons;
  if (Array.isArray(reasons) && reasons.length > 0) return String(reasons[0]);
  if (status && status !== "completed") return String(status);
  return "unknown";
}

function notCountedReason({ verdict, sourceState, reviewedHeadSha, currentHeadSha, errorCode, reason }) {
  if (currentHeadSha && reviewedHeadSha && currentHeadSha !== reviewedHeadSha) return "stale_head";
  if (verdict === "approved" || verdict === "request_changes") return "none";
  if (verdict === "timeout" || errorCode === "timeout") return "timeout";
  if (sourceState === "not_sent") return "source_not_sent";
  if (verdict === "missing") return "missing_verdict";
  if (reason === "usage_limited") return "usage_limited";
  if (reason === "sandbox_rejected" || reason === "sandbox_blocked") return "sandbox_rejected";
  if (sourceState === "sent" || sourceState === "may_be_sent" || sourceState === "sent_after_explicit_approval") {
    return "source_sent_unusable";
  }
  return "unknown";
}

function normalizeSourceState(value) {
  const normalized = String(value ?? "unknown");
  if (normalized === "not_sent" || normalized === "sent" || normalized === "unknown") return normalized;
  if (normalized === "may_be_sent" || normalized === "sent_after_explicit_approval") return normalized;
  return "unknown";
}

export function redactReviewSlotDisposition(input = {}) {
  const out = {};
  for (const field of REVIEW_SLOT_ALLOWED_FIELDS) {
    const value = input[field];
    if (field === "waiver_artifact" || field === "override_artifact") out[field] = artifactRef(value);
    else out[field] = value ?? null;
  }
  return Object.freeze(out);
}

export function buildReviewSlotDisposition({
  provider = null,
  mode = null,
  stage = "final",
  slotId = null,
  attemptId = null,
  parentAttemptId = null,
  reviewedHeadSha = null,
  currentHeadSha = null,
  retryFingerprint = null,
  retryCount = 0,
  retryDispositionRequired = false,
  requestSettingsHash = null,
  sourceState = "unknown",
  sourceSendAllowed = null,
  status = null,
  errorCode = null,
  result = "",
  reviewQuality = null,
  disposition = "none",
  waiverArtifact = null,
  overrideArtifact = null,
} = {}) {
  const source_state = normalizeSourceState(sourceState);
  const parsedVerdict = resultVerdict(result);
  let verdict = parsedVerdict ?? "missing";
  if (status === "failed" && errorCode === "timeout") verdict = "timeout";
  else if (status && status !== "completed") verdict = "failed_slot";
  if (reviewQuality?.failed_review_slot === true && (verdict === "approved" || verdict === "request_changes")) {
    verdict = "failed_slot";
  }
  // #238: a verdict reached without the source the review needed cannot count. The source-packet
  // policy sets source_send_allowed===false ONLY when the review is source-bearing AND a block
  // applies (source_packet_too_large / resend_confirmation_required) -- so this excludes legit
  // diff-only reviews (not source-bearing => allowed) and legit resumes (already sent => allowed).
  // Demote to failed_slot so notCountedReason returns source_not_sent instead of "none". This is
  // ground truth (was the source delivered), independent of the spoofable review text.
  if (sourceSendAllowed === false && (verdict === "approved" || verdict === "request_changes")) {
    verdict = "failed_slot";
  }
  const retry_fingerprint = hashValue(retryFingerprint);
  const request_settings_hash = hashValue(requestSettingsHash);
  const normalized = normalizedDisposition(disposition);
  const reason = failedSlotReason({ verdict, status, errorCode, reviewQuality });
  const retry_count = Number.isSafeInteger(retryCount) && retryCount >= 0 ? retryCount : 0;
  const failedOrMissingFinalSlot = stage === "final" && status !== "approval_request"
    && (verdict === "failed_slot" || verdict === "missing" || verdict === "timeout");
  const payload = {
    slot_id: slotId ?? hashJson({
      provider,
      mode,
      stage,
      reviewed_head_sha: reviewedHeadSha ?? null,
      retry_fingerprint,
    }),
    attempt_id: attemptId ?? null,
    parent_attempt_id: parentAttemptId ?? null,
    reviewed_head_sha: reviewedHeadSha ?? null,
    retry_fingerprint,
    retry_count,
    retry_disposition_required: retryDispositionRequired === true || failedOrMissingFinalSlot,
    request_settings_hash,
    source_state,
    verdict,
    failed_slot_reason: reason,
    disposition: normalized,
    not_counted_reason: notCountedReason({
      verdict,
      sourceState: source_state,
      reviewedHeadSha,
      currentHeadSha,
      errorCode,
      reason,
    }),
    waiver_artifact: artifactRef(waiverArtifact),
    override_artifact: artifactRef(overrideArtifact),
  };
  return redactReviewSlotDisposition(payload);
}

function previousSelectedSource(previousAttempt = null) {
  return previousAttempt?.selected_source
    ?? previousAttempt?.source_packet
    ?? previousAttempt?.review_metadata?.audit_manifest?.selected_source
    ?? null;
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
    return `Do not send selected source. Narrow or shard the ${target}source packet before retrying, or use --allow-large-source-packet only after explicitly confirming the larger packet is intentional.`;
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
  if (action === "send_after_source_packet_override") {
    return "Proceed with the explicitly approved large source packet and record the override tuple.";
  }
  return null;
}

function packetRecoveryAction(type, {
  description,
  command = null,
  sourceContentTransmission = "not_sent",
  reviewSurfaceChange = false,
  approvalRequired = false,
  approvalTuple = null,
  shards = null,
} = {}) {
  return Object.freeze({
    type,
    description,
    command,
    source_content_transmission: sourceContentTransmission,
    review_surface_change: reviewSurfaceChange,
    approval_required: approvalRequired,
    approval_tuple: approvalTuple,
    shards,
  });
}

function sourceTotalsForPacketRecovery(source = null) {
  const totals = source?.totals ?? {};
  return {
    files: Number.isSafeInteger(totals.files) ? totals.files : null,
    bytes: Number.isSafeInteger(totals.bytes) ? totals.bytes : null,
  };
}

function sourceHashForPacketRecovery(source = null) {
  const totals = sourceTotalsForPacketRecovery(source);
  if ((totals.files ?? 0) === 0 && (totals.bytes ?? 0) === 0) return null;
  return sourcePacketHash(source);
}

export function packetRecoveryReviewSurface({
  selectedSource = null,
  previousAttempt = null,
  previousSelectedSource: previousSelectedSourceInput = null,
  sourcePacketPolicy = null,
  changed = null,
  changeReason = null,
  approvalCredit = null,
} = {}) {
  const previousSourceCandidate = previousSelectedSourceInput ?? previousSelectedSource(previousAttempt);
  const originalSource = previousSourceCandidate ?? selectedSource;
  const originalTotals = sourceTotalsForPacketRecovery(originalSource);
  const currentTotals = sourceTotalsForPacketRecovery(selectedSource);
  const originalHash = sourceHashForPacketRecovery(originalSource);
  const currentHash = sourceHashForPacketRecovery(selectedSource);
  const surfaceChanged = changed ?? sourcePacketPolicy?.review_surface_changed ?? (
    originalHash !== null && currentHash !== null && originalHash !== currentHash
  );
  return Object.freeze({
    original_packet_hash: originalHash,
    current_packet_hash: currentHash,
    original_files: originalTotals.files,
    current_files: currentTotals.files,
    original_bytes: originalTotals.bytes,
    current_bytes: currentTotals.bytes,
    changed: surfaceChanged,
    change_reason: changeReason ?? (surfaceChanged ? "narrowed_scope" : "none"),
    approval_credit: approvalCredit ?? (surfaceChanged ? "changed_surface_only" : "none"),
    coverage_proof: null,
  });
}

export function reviewQualityPacketRecoveryErrorCode(reviewQuality = null) {
  const semanticReasons = Array.isArray(reviewQuality?.semantic_failure_reasons)
    ? reviewQuality.semantic_failure_reasons
    : [];
  return reviewQuality?.failed_review_slot === true && semanticReasons.length > 0
    ? "review_not_completed"
    : null;
}

function sourceContentWasPossiblySent(value = null) {
  return value === "sent"
    || value === "may_be_sent"
    || value === "sent_after_explicit_approval"
    || value === "unknown";
}

export function sourceSentPacketRecoveryReason({
  status = null,
  errorCode = null,
  sourceContentTransmission = null,
  reviewQuality = null,
} = {}) {
  if (!sourceContentWasPossiblySent(sourceContentTransmission)) return null;
  if (status === "failed" && SOURCE_SENT_PACKET_RECOVERY_FAILURES.has(errorCode)) return errorCode;
  return reviewQualityPacketRecoveryErrorCode(reviewQuality);
}

function providerRecoveryCapabilitiesSnapshot({
  provider = null,
  routeStep = null,
  providerCapabilities = {},
  sourcePacketPolicy = null,
  renderedPromptBudgetChars = null,
  perFileSecureReadCapBytes = null,
  supportsDiffPacket = true,
  supportsShardPlan = true,
  requiresSourceSendApproval = false,
  requiresResendConfirmationAfterSourceSentFailure = true,
  localSourcePacketPolicyPreSend = true,
  sourceSentRuntimeFailuresFailedSlot = true,
  transportFallbacks = [],
} = {}) {
  const selectedRouteStep = routeStep ?? sourcePacketPolicy?.route_step ?? null;
  const selectedProvider = provider ?? sourcePacketPolicy?.provider ?? null;
  return Object.freeze({
    provider: selectedProvider,
    canonical_provider: providerCapabilities?.canonical_provider ?? selectedProvider,
    route_step: selectedRouteStep,
    source_packet_budget_bytes: Number.isSafeInteger(sourcePacketPolicy?.source_packet_budget_bytes)
      ? sourcePacketPolicy.source_packet_budget_bytes
      : null,
    rendered_prompt_budget_chars: Number.isSafeInteger(renderedPromptBudgetChars)
      ? renderedPromptBudgetChars
      : null,
    per_file_secure_read_cap_bytes: Number.isSafeInteger(perFileSecureReadCapBytes)
      ? perFileSecureReadCapBytes
      : null,
    supports_diff_packet: supportsDiffPacket === true,
    supports_shard_plan: supportsShardPlan === true,
    supports_no_source_resume: sourcePacketResumeWithoutResendSupported(providerCapabilities, selectedRouteStep),
    requires_source_send_approval: requiresSourceSendApproval === true,
    requires_resend_confirmation_after_source_sent_failure:
      requiresResendConfirmationAfterSourceSentFailure !== false,
    local_source_packet_policy_pre_send: localSourcePacketPolicyPreSend !== false,
    source_sent_runtime_failures_failed_slot: sourceSentRuntimeFailuresFailedSlot !== false,
    transport_fallbacks: Object.freeze(Array.isArray(transportFallbacks) ? [...transportFallbacks] : []),
  });
}

function sourcePacketRecoveryActions({ reason = null, sourcePacketPolicy = null, capabilities, shardPlans = null }) {
  if (reason === "prompt_too_large") {
    const actions = [];
    if (capabilities.supports_shard_plan && Array.isArray(shardPlans) && shardPlans.length > 0) {
      actions.push(packetRecoveryAction("shard", {
        description: "Retry as bounded prompt shards.",
        reviewSurfaceChange: true,
        approvalRequired: capabilities.requires_source_send_approval,
        shards: Object.freeze([...shardPlans]),
      }));
    }
    actions.push(
      packetRecoveryAction("diff_packet", {
        description: "Retry with a narrower prompt and source packet.",
        reviewSurfaceChange: true,
        approvalRequired: capabilities.requires_source_send_approval,
      }),
      packetRecoveryAction("switch_provider", {
        description: "Retry with another provider that has a larger rendered prompt budget.",
      }),
      packetRecoveryAction("waive_slot", {
        description: "Waive this failed review slot with an explicit operator artifact.",
        approvalRequired: true,
      }),
    );
    return Object.freeze(actions);
  }

  if (reason === "source_packet_too_large" || sourcePacketPolicy?.source_packet_policy_error_code === "source_packet_too_large") {
    const actions = [];
    if (capabilities.supports_shard_plan && Array.isArray(shardPlans) && shardPlans.length > 0) {
      actions.push(packetRecoveryAction("shard", {
        description: "Split the selected source into smaller review shards.",
        reviewSurfaceChange: true,
        approvalRequired: capabilities.requires_source_send_approval,
        shards: Object.freeze([...shardPlans]),
      }));
    }
    actions.push(
      packetRecoveryAction("diff_packet", {
        description: "Send a narrower diff-only packet for the same review.",
        reviewSurfaceChange: true,
        approvalRequired: capabilities.requires_source_send_approval,
      }),
      packetRecoveryAction("allow_large_source_packet", {
        description: "Retry with an explicit large source packet override.",
        approvalRequired: true,
      }),
      packetRecoveryAction("switch_provider", {
        description: "Retry with another provider that has a larger packet budget.",
      }),
      packetRecoveryAction("waive_slot", {
        description: "Waive this failed review slot with an explicit operator artifact.",
        approvalRequired: true,
      }),
    );
    return Object.freeze(actions);
  }

  if (reason === "resend_confirmation_required" || sourcePacketPolicy?.source_packet_policy_error_code === "resend_confirmation_required") {
    const actions = [
      packetRecoveryAction("resend_with_confirmation", {
        description: "Retry only after explicit source resend confirmation.",
        approvalRequired: true,
      }),
    ];
    if (capabilities.supports_no_source_resume) {
      actions.push(packetRecoveryAction("resume_without_source_resend", {
        description: "Resume the retained provider session without resending selected source.",
      }));
    }
    actions.push(
      packetRecoveryAction("switch_provider", {
        description: "Retry with another provider.",
      }),
      packetRecoveryAction("waive_slot", {
        description: "Waive this failed review slot with an explicit operator artifact.",
        approvalRequired: true,
      }),
    );
    return Object.freeze(actions);
  }

  if (SOURCE_SENT_PACKET_RECOVERY_FAILURES.has(reason)) {
    const actions = [
      packetRecoveryAction("resend_with_confirmation", {
        description: "Retry only after explicit source resend confirmation.",
        approvalRequired: true,
      }),
    ];
    if (capabilities.supports_no_source_resume && SOURCE_SENT_PACKET_RESUME_FAILURES.has(reason)) {
      actions.push(packetRecoveryAction("resume_without_source_resend", {
        description: "Resume the retained provider session without resending selected source.",
      }));
    }
    actions.push(
      packetRecoveryAction("switch_provider", {
        description: "Retry with another provider.",
      }),
      packetRecoveryAction("waive_slot", {
        description: "Waive this failed review slot with an explicit operator artifact.",
        approvalRequired: true,
      }),
    );
    return Object.freeze(actions);
  }

  return Object.freeze([
    packetRecoveryAction("switch_provider", {
      description: "Retry with another provider.",
    }),
    packetRecoveryAction("waive_slot", {
      description: "Waive this failed review slot with an explicit operator artifact.",
      approvalRequired: true,
    }),
  ]);
}

export function buildPacketRecovery({
  reason,
  sourcePacketPolicy = null,
  providerCapabilities = {},
  provider = null,
  mode = null,
  routeStep = null,
  reviewSurface = null,
  selectedSource = null,
  previousSelectedSource = null,
  sourceContentTransmission = null,
  renderedPromptBudgetChars = null,
  perFileSecureReadCapBytes = null,
  supportsDiffPacket = true,
  supportsShardPlan = true,
  requiresSourceSendApproval = false,
  requiresResendConfirmationAfterSourceSentFailure = true,
  localSourcePacketPolicyPreSend = true,
  sourceSentRuntimeFailuresFailedSlot = true,
  transportFallbacks = [],
  shardPlans = null,
} = {}) {
  const capabilities = providerRecoveryCapabilitiesSnapshot({
    provider,
    routeStep,
    providerCapabilities,
    sourcePacketPolicy,
    renderedPromptBudgetChars,
    perFileSecureReadCapBytes,
    supportsDiffPacket,
    supportsShardPlan,
    requiresSourceSendApproval,
    requiresResendConfirmationAfterSourceSentFailure,
    localSourcePacketPolicyPreSend,
    sourceSentRuntimeFailuresFailedSlot,
    transportFallbacks,
  });
  const recoveryReason = reason ?? sourcePacketPolicy?.source_packet_policy_error_code ?? null;
  const actions = sourcePacketRecoveryActions({
    reason: recoveryReason,
    sourcePacketPolicy,
    capabilities,
    shardPlans,
  });
  return Object.freeze({
    schema_version: 1,
    provider: capabilities.provider,
    mode: mode ?? sourcePacketPolicy?.mode ?? null,
    reason: recoveryReason,
    source_content_transmission:
      sourceContentTransmission ?? sourcePacketPolicy?.source_content_transmission ?? "not_sent",
    failed_review_slot: true,
    provider_capabilities: capabilities,
    review_surface: reviewSurface ?? packetRecoveryReviewSurface({
      selectedSource,
      previousSelectedSource,
      changed: sourcePacketPolicy?.review_surface_changed ?? null,
    }),
    actions,
  });
}

export function evaluateRenderedPromptTransportPolicy({
  provider = null,
  routeStep = null,
  providerCapabilities = {},
  prompt = "",
  sourcePacketPolicy = null,
  sourceContentTransmission = "not_sent",
} = {}) {
  const budgetBytes = renderedPromptTransportBudgetBytes(providerCapabilities, routeStep);
  if (budgetBytes == null) return null;
  const renderedPromptBytes = Buffer.byteLength(prompt ?? "", "utf8");
  if (renderedPromptBytes <= budgetBytes) return null;

  const capability = renderedPromptTransportCapability(providerCapabilities, routeStep) ?? {};
  const transport = capability.transport ?? "rendered_prompt";
  const providerTarget = provider ? `${provider} ` : "";
  const policy = {
    ...(sourcePacketPolicy ?? {}),
    source_send_allowed: false,
    source_packet_action: "narrow_source_packet",
    source_content_transmission: sourceContentTransmission,
    source_packet_policy_error_code: "prompt_too_large",
    suggested_action:
      `Do not send selected source. Narrow or shard the ${providerTarget}prompt before retrying; ` +
      "--allow-large-source-packet cannot bypass the rendered prompt transport cap.",
    rendered_prompt_bytes: renderedPromptBytes,
    rendered_prompt_transport_budget_bytes: budgetBytes,
    transport,
  };
  if (transport === "argv_print") {
    policy.rendered_prompt_argv_budget_bytes = budgetBytes;
  }
  return Object.freeze(policy);
}

export function renderedPromptTransportRuntimeDiagnostics(policy = null) {
  if (!policy || policy.source_packet_policy_error_code !== "prompt_too_large") return Object.freeze({});
  return Object.freeze({
    rendered_prompt_transport: Object.freeze({
      rendered_prompt_bytes: Number.isSafeInteger(policy.rendered_prompt_bytes)
        ? policy.rendered_prompt_bytes
        : null,
      max_bytes: Number.isSafeInteger(policy.rendered_prompt_transport_budget_bytes)
        ? policy.rendered_prompt_transport_budget_bytes
        : null,
      transport: typeof policy.transport === "string" ? policy.transport : null,
    }),
  });
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
  sourcePacketOverrideApproved = false,
  sourcePacketOverrideSource = null,
} = {}) {
  const totals = selectedSourceTotals(selectedSource);
  const packetBudgetBytes = sourcePacketBudgetBytes(providerCapabilities, routeStep);
  const resumeWithoutResendSupported = sourcePacketResumeWithoutResendSupported(providerCapabilities, routeStep);
  const effectiveSourceBearing = sourceBearing === true || totals.bytes > 0 || totals.files > 0;
  const sourcePacketWithinBudget = totals.bytes <= packetBudgetBytes;
  const sourcePacketOverride = sourcePacketOverrideApproved === true;
  const previousSource = previousSelectedSource(previousAttempt);
  const previousTotals = selectedSourceTotals(previousSource);
  const previousHash = sourcePacketHash(previousSource);
  const currentHash = sourcePacketHash(selectedSource);
  const reviewSurfaceChanged = previousHash !== null && currentHash !== null && previousHash !== currentHash;
  const narrowedSourcePacket = previousSource !== null
    && (totals.bytes > 0 || totals.files > 0)
    && totals.bytes < previousTotals.bytes;

  const base = {
    provider,
    mode,
    route_step: routeStep,
    source_bearing: effectiveSourceBearing,
    source_packet_budget_bytes: packetBudgetBytes,
    selected_source_bytes: totals.bytes,
    source_packet_within_budget: sourcePacketWithinBudget,
    source_packet_override_approved: sourcePacketOverride,
    source_packet_override_source: sourcePacketOverride
      ? (sourcePacketOverrideSource ?? "unknown")
      : null,
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

  if (!sourcePacketWithinBudget && !sourcePacketOverride) {
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
    && resumeWithoutResendSupported
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

  const action = sourcePacketWithinBudget ? "send" : "send_after_source_packet_override";
  return Object.freeze({
    ...base,
    source_send_allowed: true,
    source_packet_action: action,
    source_content_transmission: "may_be_sent",
    suggested_action: sourcePacketSuggestedAction(action, provider),
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
