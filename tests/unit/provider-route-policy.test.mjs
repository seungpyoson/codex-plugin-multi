import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeApprovalScope,
  buildProviderPolicyContract,
  buildReviewSlotDisposition,
  evaluateSourcePacketPolicy,
  evaluateReviewSlotRetryPolicy,
  PROVIDER_POLICY_DOMAINS,
  PROVIDER_ROUTE_STEPS,
  redactReviewSlotDisposition,
  reviewSlotRetryFingerprint,
  selectProviderRoute,
  sourceSendApprovalProofMatches,
  sourceSendApprovalTupleFingerprint,
  sourcePacketCanResumeWithoutResendFromJobRecord,
  sourcePacketCanResumeWithoutResendFromPreviousAttempt,
  sourcePacketPreviousAttemptForContinuation,
  sourcePacketPreviousAttemptFromJobRecord,
  latestSourcePacketPreviousAttempt,
  resolveConcurrencyAdmission,
} from "../../scripts/lib/provider-route-policy.mjs";
import * as providerRoutePolicy from "../../scripts/lib/provider-route-policy.mjs";
import { REVIEW_PROMPT_PLUGIN_TARGETS } from "../../scripts/lib/plugin-targets.mjs";
import { buildReviewAuditManifest } from "../../scripts/lib/review-prompt.mjs";
import { PRE_TARGET_NOT_SENT_ERROR_CODES } from "../../scripts/lib/external-review.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const subscriptionAndApi = Object.freeze({
  subscription: { kind: "oauth", auth_path: "subscription_oauth" },
  api: {
    kind: "direct_api",
    auth_path: "api_key_env",
    billing_path: { endpoint: "https://api.example.invalid", model: "review-model" },
    credential_env_names: ["PROVIDER_API_KEY"],
  },
});

const apiOnly = Object.freeze({
  api: {
    kind: "direct_api",
    auth_path: "api_key_env",
    billing_path: { endpoint: "https://api-only.example.invalid", model: "review-model" },
    credential_env_names: ["API_ONLY_KEY"],
  },
});

const subscriptionOnly = Object.freeze({
  subscription: { kind: "oauth", auth_path: "subscription_oauth" },
});

const openRouterOnly = Object.freeze({
  openrouter: {
    kind: "openrouter",
    auth_path: "openrouter_api_key_env",
    billing_path: { endpoint: "https://openrouter.ai/api/v1", model: "provider/review-model" },
    credential_env_names: ["OPENROUTER_API_KEY"],
  },
});

const allCapabilities = Object.freeze({
  ...subscriptionAndApi,
  openrouter: openRouterOnly.openrouter,
});

const requiredPolicyDomains = [
  "route",
  "packet",
  "readiness_auth",
  "status_lifecycle",
  "failure_taxonomy",
  "suggested_action",
  "review_quality",
  "review_slot",
  "audit",
  "docs",
  "sync",
];

const REVIEW_MODES = ["review", "adversarial-review", "custom-review", "rescue"];

async function providerRoutePolicyModules() {
  const packaged = await Promise.all(
    REVIEW_PROMPT_PLUGIN_TARGETS.map(async (plugin) => [
      plugin,
      await import(`../../plugins/${plugin}/scripts/lib/provider-route-policy.mjs`),
    ]),
  );
  return [["shared", providerRoutePolicy], ...packaged];
}

function selectedSourceFixture(bytes) {
  return Object.freeze({
    files: Object.freeze([
      Object.freeze({
        path: "src/example.js",
        bytes,
        lines: 1,
        content_hash: Object.freeze({ algorithm: "sha256", value: `fixture-${bytes}` }),
      }),
    ]),
    totals: Object.freeze({ files: 1, bytes, lines: 1 }),
  });
}

test("shared source-sent packet recovery policy covers retryable provider failures", () => {
  assert.equal(typeof providerRoutePolicy.sourceSentPacketRecoveryReason, "function");
  assert.equal(
    providerRoutePolicy.sourceSentPacketRecoveryReason({
      status: "failed",
      errorCode: "provider_unavailable",
      sourceContentTransmission: "sent",
    }),
    "provider_unavailable",
  );
  assert.equal(
    providerRoutePolicy.sourceSentPacketRecoveryReason({
      status: "failed",
      errorCode: "timeout",
      sourceContentTransmission: "may_be_sent",
    }),
    "timeout",
  );
  assert.equal(
    providerRoutePolicy.sourceSentPacketRecoveryReason({
      status: "failed",
      errorCode: "provider_unavailable",
      sourceContentTransmission: "not_sent",
    }),
    null,
  );
});

test("shared packet recovery review surface marks narrowed packets changed-surface only", () => {
  assert.equal(typeof providerRoutePolicy.packetRecoveryReviewSurface, "function");
  const previousAttempt = sourcePacketPreviousAttemptFromJobRecord({
    job_id: "job_previous",
    status: "failed",
    error_code: "review_not_completed",
    external_review: { source_content_transmission: "sent" },
    review_metadata: {
      audit_manifest: {
        selected_source: selectedSourceFixture(20),
      },
    },
  });

  const surface = providerRoutePolicy.packetRecoveryReviewSurface({
    selectedSource: selectedSourceFixture(8),
    previousAttempt,
  });

  assert.equal(surface.changed, true);
  assert.equal(surface.change_reason, "narrowed_scope");
  assert.equal(surface.approval_credit, "changed_surface_only");
  assert.equal(surface.original_bytes, 20);
  assert.equal(surface.current_bytes, 8);
  assert.notEqual(surface.original_packet_hash, surface.current_packet_hash);
});

test("latest source packet previous attempt prefers chronological latest when timestamps exist", () => {
  const older = {
    attempt_id: "job_older",
    started_at: "2026-05-29T01:00:00.000Z",
    selected_source: selectedSourceFixture(10),
  };
  const newer = {
    attempt_id: "job_newer",
    started_at: "2026-05-29T02:00:00.000Z",
    selected_source: selectedSourceFixture(20),
  };

  assert.equal(latestSourcePacketPreviousAttempt([newer, older]), newer);
});

test("review slot retry fingerprint ignores request settings and failure codes", () => {
  const base = {
    provider: "kimi",
    mode: "review",
    renderedPromptHash: { algorithm: "sha256", value: "prompt-hash" },
    selectedSource: selectedSourceFixture(12),
    reviewedHeadSha: "abc123",
    routeStep: "subscription",
    scope: {
      name: "branch-diff",
      base: "origin/main",
      paths: ["src/example.js"],
    },
    request: {
      model: "kimi-code",
      timeoutMs: 900000,
      maxStepsPerTurn: 32,
    },
    failureCode: "timeout",
  };

  const fingerprint = reviewSlotRetryFingerprint(base);
  assert.equal(fingerprint.algorithm, "sha256");
  assert.match(fingerprint.value, /^[a-f0-9]{64}$/);
  assert.deepEqual(fingerprint.ingredients.scope_paths, ["src/example.js"]);

  assert.equal(reviewSlotRetryFingerprint({
    ...base,
    request: { model: "kimi-code", timeoutMs: 1, maxStepsPerTurn: 999 },
    failureCode: "step_limit_exceeded",
  }).value, fingerprint.value);

  assert.notEqual(reviewSlotRetryFingerprint({
    ...base,
    reviewedHeadSha: "def456",
  }).value, fingerprint.value);

  const pathHmacFingerprint = reviewSlotRetryFingerprint({
    ...base,
    scope: {
      ...base.scope,
      path_hmacs: ["hmac-b", "hmac-a"],
    },
  });
  assert.deepEqual(pathHmacFingerprint.ingredients.scope_path_hmacs, ["hmac-a", "hmac-b"]);
  assert.notEqual(pathHmacFingerprint.value, fingerprint.value);
  assert.notEqual(reviewSlotRetryFingerprint({
    ...base,
    scope: {
      ...base.scope,
      path_hmacs: ["hmac-c"],
    },
  }).value, pathHmacFingerprint.value);
});

test("source-send approval proof is reusable only for an unchanged approval tuple", () => {
  const base = {
    provider: "deepseek",
    mode: "custom-review",
    selectedSource: selectedSourceFixture(12),
    renderedPromptHash: { algorithm: "sha256", value: "prompt-hash" },
    scopeResolution: {
      scope: "custom",
      scope_base: "origin/main",
      scope_paths: ["src/example.js"],
      reason: "explicit_paths",
    },
    requestSettings: {
      provider: "DeepSeek",
      model: "deepseek-chat",
      timeout_ms: 900000,
      max_tokens: 16000,
      max_steps_per_turn: null,
      temperature: 0.2,
      stream: false,
    },
    authPath: "api_key_env",
    billingPath: { endpoint: "https://api.deepseek.example/v1", model: "deepseek-chat" },
    selectedRoute: "direct_api",
    routeStep: "direct_api",
    routeSteps: [{ route: "direct_api", supported: true, attempted: true, selected: true, skipped_reason: null, fallback_reason: null }],
    fallbackReason: "explicit_api",
    approvalScope: "session",
  };

  const proof = sourceSendApprovalTupleFingerprint(base);
  assert.equal(proof.algorithm, "sha256");
  assert.match(proof.value, /^[a-f0-9]{64}$/);
  assert.equal(sourceSendApprovalProofMatches({
    approved: proof,
    current: sourceSendApprovalTupleFingerprint({
      ...base,
      scopeResolution: { ...base.scopeResolution, scope_paths: ["src/example.js"] },
    }),
  }), true);

  const variants = [
    ["provider", { provider: "glm" }],
    ["mode", { mode: "adversarial-review" }],
    ["source packet", { selectedSource: selectedSourceFixture(13) }],
    ["prompt hash", { renderedPromptHash: { algorithm: "sha256", value: "different-prompt" } }],
    ["scope resolution", { scopeResolution: { ...base.scopeResolution, scope_paths: ["src/other.js"] } }],
    ["request settings", { requestSettings: { ...base.requestSettings, max_tokens: 8000 } }],
    ["auth path", { authPath: "oauth" }],
    ["billing path", { billingPath: { endpoint: "https://api.deepseek.example/v1", model: "deepseek-reasoner" } }],
    ["selected route", { selectedRoute: "openrouter" }],
    ["fallback reason", { fallbackReason: "usage_limited" }],
    ["approval scope", { approvalScope: "once" }],
  ];

  for (const [label, patch] of variants) {
    const changed = sourceSendApprovalTupleFingerprint({ ...base, ...patch });
    assert.equal(sourceSendApprovalProofMatches({ approved: proof, current: changed }), false, label);
    assert.notEqual(changed.value, proof.value, label);
  }
});

test("review slot retry policy fail-closes third same-packet attempt", () => {
  const retryFingerprint = reviewSlotRetryFingerprint({
    provider: "kimi",
    mode: "review",
    renderedPromptHash: { algorithm: "sha256", value: "prompt-hash" },
    selectedSource: selectedSourceFixture(12),
    reviewedHeadSha: "abc123",
    routeStep: "subscription",
    scope: { name: "branch-diff", base: "origin/main", paths: ["src/example.js"] },
  });
  const priorAttempts = [
    { retry_fingerprint: retryFingerprint.value, attempt_id: "attempt-1" },
    { retry_fingerprint: retryFingerprint.value, attempt_id: "attempt-2" },
    { retry_fingerprint: "different", attempt_id: "attempt-other" },
  ];

  const blocked = evaluateReviewSlotRetryPolicy({
    retryFingerprint,
    priorAttempts,
    disposition: "retry",
  });

  assert.equal(blocked.retry_count, 2);
  assert.equal(blocked.retry_disposition_required, true);
  assert.equal(blocked.slot_retry_allowed, false);
  assert.equal(blocked.source_send_allowed, false);
  assert.equal(blocked.fail_closed_reason, "retry_disposition_not_valid_for_third_attempt");

  for (const disposition of ["split", "switch_provider"]) {
    const samePacket = evaluateReviewSlotRetryPolicy({
      retryFingerprint,
      priorAttempts,
      disposition,
    });
    assert.equal(samePacket.retry_count, 2, disposition);
    assert.equal(samePacket.slot_retry_allowed, false, disposition);
    assert.equal(samePacket.source_send_allowed, false, disposition);
    assert.equal(samePacket.fail_closed_reason, "third_same_packet_retry_requires_disposition", disposition);
  }

  const accumulated = evaluateReviewSlotRetryPolicy({
    retryFingerprint,
    priorAttempts: [
      { review_slot: { retry_fingerprint: retryFingerprint, retry_count: 0, attempt_id: "attempt-1" } },
      { review_slot: { retry_fingerprint: retryFingerprint, retry_count: 1, attempt_id: "attempt-2" } },
    ],
    disposition: "override",
    overrideArtifact: "reviews/override-180.md",
  });

  assert.equal(accumulated.retry_count, 2);
  assert.equal(accumulated.slot_retry_allowed, true);

  assert.equal(evaluateReviewSlotRetryPolicy({
    retryFingerprint,
    priorAttempts: priorAttempts.slice(0, 1),
    disposition: "retry",
  }).slot_retry_allowed, true);

  const waiverWithoutArtifact = evaluateReviewSlotRetryPolicy({
    retryFingerprint,
    priorAttempts: priorAttempts.slice(0, 1),
    disposition: "waive",
  });
  assert.equal(waiverWithoutArtifact.slot_retry_allowed, false);
  assert.equal(waiverWithoutArtifact.source_send_allowed, false);
  assert.equal(waiverWithoutArtifact.fail_closed_reason, "review_slot_waiver_artifact_required");

  const overrideWithWindowsAbsolutePath = evaluateReviewSlotRetryPolicy({
    retryFingerprint,
    priorAttempts,
    disposition: "override",
    overrideArtifact: "C:\\temp\\override-180.md",
  });
  assert.equal(overrideWithWindowsAbsolutePath.slot_retry_allowed, false);
  assert.equal(overrideWithWindowsAbsolutePath.source_send_allowed, false);

  assert.equal(evaluateReviewSlotRetryPolicy({
    retryFingerprint,
    priorAttempts,
    disposition: "override",
    overrideArtifact: "reviews/override-180.md",
  }).slot_retry_allowed, true);
});

test("review slot retry policy ignores not-sent and stale prior slots", () => {
  const retryFingerprint = reviewSlotRetryFingerprint({
    provider: "deepseek",
    mode: "custom-review",
    renderedPromptHash: { algorithm: "sha256", value: "prompt-hash" },
    selectedSource: selectedSourceFixture(12),
    reviewedHeadSha: "abc123",
    routeStep: "direct_api",
    scope: { name: "custom", base: null, paths: ["src/example.js"] },
  });

  const policy = evaluateReviewSlotRetryPolicy({
    retryFingerprint,
    priorAttempts: [
      {
        review_slot: {
          retry_fingerprint: retryFingerprint,
          source_state: "not_sent",
          not_counted_reason: "source_not_sent",
        },
      },
      {
        review_slot: {
          retry_fingerprint: retryFingerprint,
          source_state: "sent",
          not_counted_reason: "stale_head",
        },
      },
      {
        review_slot: {
          retry_fingerprint: retryFingerprint,
          source_state: "sent",
          verdict: "approved",
        },
      },
      {
        review_slot: {
          retry_fingerprint: retryFingerprint,
          source_state: "sent",
          not_counted_reason: "missing_verdict",
        },
      },
    ],
    disposition: "retry",
  });

  assert.equal(policy.retry_count, 1);
  assert.equal(policy.slot_retry_allowed, true);
});

test("review slot disposition redacts raw fields and excludes stale-head approvals", () => {
  const disposition = buildReviewSlotDisposition({
    provider: "claude",
    mode: "review",
    stage: "final",
    attemptId: "job-1",
    parentAttemptId: null,
    reviewedHeadSha: "old-head",
    currentHeadSha: "new-head",
    retryFingerprint: { algorithm: "sha256", value: "f".repeat(64) },
    retryCount: 0,
    requestSettingsHash: { algorithm: "sha256", value: "r".repeat(64) },
    sourceState: "sent",
    status: "completed",
    result: "Verdict: APPROVE\nBlocking findings: none",
    reviewQuality: { failed_review_slot: false, semantic_failure_reasons: [] },
    raw_source: "secret source",
    prompt: "secret prompt",
    provider_output: "secret output",
    command_args: ["--token", "secret"],
  });

  assert.equal(disposition.verdict, "approved");
  assert.equal(disposition.not_counted_reason, "stale_head");
  assert.equal(disposition.disposition, "none");
  assert.equal(JSON.stringify(disposition).includes("secret"), false);

  const redacted = redactReviewSlotDisposition({
    ...disposition,
    raw_path: "/tmp/source/private.js",
    provider_output: "secret output",
  });
  assert.equal(JSON.stringify(redacted).includes("secret"), false);
  assert.equal(JSON.stringify(redacted).includes("/tmp/source/private.js"), false);
});

test("review slot disposition requires disposition for finalized failed or missing slots", () => {
  for (const result of ["", "Verdict: NOT_REVIEWED"]) {
    const disposition = buildReviewSlotDisposition({
      provider: "gemini",
      mode: "adversarial-review",
      stage: "final",
      attemptId: "job-failed",
      reviewedHeadSha: "head",
      currentHeadSha: "head",
      retryFingerprint: "f".repeat(64),
      retryCount: 0,
      sourceState: "sent",
      status: "completed",
      result,
      reviewQuality: result
        ? { failed_review_slot: true, semantic_failure_reasons: ["not_reviewed"] }
        : { failed_review_slot: false, semantic_failure_reasons: [] },
    });

    assert.equal(disposition.retry_count, 0);
    assert.equal(disposition.retry_disposition_required, true);
    assert.notEqual(disposition.verdict, "approved");
  }
});

test("review slot disposition never counts failed process output as approval", () => {
  for (const result of ["Verdict: APPROVE", "Verdict: REQUEST_CHANGES"]) {
    const disposition = buildReviewSlotDisposition({
      provider: "claude",
      mode: "review",
      stage: "final",
      attemptId: "job-failed",
      reviewedHeadSha: "head",
      currentHeadSha: "head",
      retryFingerprint: "f".repeat(64),
      retryCount: 0,
      sourceState: "sent",
      status: "failed",
      errorCode: "auth_failed",
      result,
      reviewQuality: null,
    });

    assert.equal(disposition.verdict, "failed_slot");
    assert.equal(disposition.failed_slot_reason, "auth_failed");
    assert.equal(disposition.not_counted_reason, "source_sent_unusable");
    assert.equal(disposition.retry_disposition_required, true);
  }
});

// #238: an approval/request_changes on a source-bearing review whose source send was BLOCKED
// (source_send_allowed === false: e.g. source_packet_too_large, resend_confirmation_required)
// reviewed without the source it needed -- it must NOT count as a satisfied review. The decidable
// signal is source_send_allowed===false, which the policy sets only when the review is
// source-bearing AND a block applies, so it cleanly excludes legit diff-only (not source-bearing)
// and legit resume (send still allowed) reviews.
test("review slot disposition does not count an approval when the required source was blocked (#238)", () => {
  for (const result of ["Verdict: APPROVE\nBlocking findings: none.", "Verdict: REQUEST_CHANGES\nBlocking findings: one."]) {
    const disposition = buildReviewSlotDisposition({
      provider: "claude",
      mode: "review",
      stage: "final",
      attemptId: "job-source-blocked",
      reviewedHeadSha: "head",
      currentHeadSha: "head",
      retryFingerprint: "f".repeat(64),
      retryCount: 0,
      sourceState: "not_sent",
      sourceSendAllowed: false,
      status: "completed",
      errorCode: null,
      result,
      reviewQuality: { failed_review_slot: false, semantic_failure_reasons: [] },
    });
    assert.equal(disposition.verdict, "failed_slot");
    assert.notEqual(disposition.not_counted_reason, "none");
    assert.equal(disposition.not_counted_reason, "source_not_sent");
  }
});

// Precision guard: the #238 demotion must NOT touch legit approvals -- a not-source-bearing
// (diff-only) review and a source-sent review keep counting.
test("review slot disposition still counts legit approvals (diff-only / source-sent) (#238 precision)", () => {
  const base = {
    provider: "claude",
    mode: "review",
    stage: "final",
    attemptId: "job-legit",
    reviewedHeadSha: "head",
    currentHeadSha: "head",
    retryFingerprint: "f".repeat(64),
    retryCount: 0,
    status: "completed",
    errorCode: null,
    result: "Verdict: APPROVE\nBlocking findings: none.",
    reviewQuality: { failed_review_slot: false, semantic_failure_reasons: [] },
  };
  const diffOnly = buildReviewSlotDisposition({ ...base, sourceState: "not_sent", sourceSendAllowed: true });
  assert.equal(diffOnly.verdict, "approved");
  assert.equal(diffOnly.not_counted_reason, "none");

  const sourceSent = buildReviewSlotDisposition({ ...base, sourceState: "sent", sourceSendAllowed: true });
  assert.equal(sourceSent.verdict, "approved");
  assert.equal(sourceSent.not_counted_reason, "none");
});

function assertRouteStepLedger(route) {
  assert.deepEqual(route.route_steps.map((step) => step.route), PROVIDER_ROUTE_STEPS);
  for (const step of route.route_steps) {
    assert.deepEqual(Object.keys(step).sort(), [
      "attempted",
      "fallback_reason",
      "route",
      "selected",
      "skipped_reason",
      "supported",
    ]);
    assert.equal(typeof step.attempted, "boolean");
    assert.equal(typeof step.selected, "boolean");
    assert.equal(typeof step.supported, "boolean");
    assert.equal(step.skipped_reason === null || typeof step.skipped_reason === "string", true);
    assert.equal(step.fallback_reason === null || typeof step.fallback_reason === "string", true);
  }
}

test("provider policy contract exposes the full cross-cutting policy surface", () => {
  assert.deepEqual(PROVIDER_ROUTE_STEPS, ["subscription", "direct_api", "openrouter"]);
  assert.deepEqual(
    PROVIDER_POLICY_DOMAINS.map((domain) => domain.name),
    requiredPolicyDomains,
  );

  const contract = buildProviderPolicyContract();
  assert.deepEqual(contract.providers, ["claude", "gemini", "kimi", "grok", "deepseek", "glm"]);
  assert.deepEqual(
    contract.domains.map((domain) => domain.name),
    requiredPolicyDomains,
  );
  for (const domain of contract.domains) {
    assert.equal(domain.shared_policy, true, `${domain.name} must be shared policy`);
    assert.equal(Array.isArray(domain.required_fields), true, `${domain.name} must define fields`);
    assert.equal(domain.required_fields.length > 0, true, `${domain.name} must not be empty`);
  }
});

test("source packet policy blocks over-budget packets for every provider and source-bearing mode before source send", () => {
  const contract = buildProviderPolicyContract();

  for (const provider of contract.providers) {
    for (const mode of REVIEW_MODES) {
      const policy = evaluateSourcePacketPolicy({
        provider,
        mode,
        routeStep: "subscription",
        providerCapabilities: {
          subscription: { source_packet: { max_bytes: 10 } },
        },
        selectedSource: selectedSourceFixture(11),
        sourceBearing: true,
      });

      assert.equal(policy.provider, provider);
      assert.equal(policy.mode, mode);
      assert.equal(policy.source_send_allowed, false);
      assert.equal(policy.source_packet_action, "narrow_source_packet");
      assert.equal(policy.source_packet_policy_error_code, "source_packet_too_large");
      assert.equal(policy.source_content_transmission, "not_sent");
      assert.equal(policy.source_packet_budget_bytes, 10);
      assert.equal(policy.selected_source_bytes, 11);
      assert.equal(policy.source_packet_within_budget, false);
      assert.equal(policy.source_packet_override_approved, false);
      assert.equal(policy.source_packet_override_source, null);
      assert.equal(policy.resend_confirmation_required, false);
    }
  }
});

test("packet recovery omits no-source resume when provider capabilities do not support it", () => {
  assert.equal(typeof providerRoutePolicy.buildPacketRecovery, "function");

  const sourcePacketPolicy = evaluateSourcePacketPolicy({
    provider: "kimi",
    mode: "custom-review",
    routeStep: "subscription",
    providerCapabilities: {
      subscription: {
        source_packet: {
          max_bytes: 20,
          resume_without_resend_supported: false,
        },
      },
    },
    selectedSource: Object.freeze({
      files: Object.freeze([]),
      totals: Object.freeze({ files: 0, bytes: 0, lines: 0 }),
    }),
    sourceBearing: true,
    previousAttempt: {
      status: "failed",
      error_code: "step_limit_exceeded",
      source_content_transmission: "sent",
      selected_source: selectedSourceFixture(8),
    },
    resumeWithoutSourceResend: true,
  });

  const recovery = providerRoutePolicy.buildPacketRecovery({
    reason: "step_limit_exceeded",
    sourcePacketPolicy,
    providerCapabilities: {
      subscription: {
        source_packet: {
          max_bytes: 20,
          resume_without_resend_supported: false,
        },
      },
    },
    reviewSurface: {
      original_packet_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      current_packet_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      original_files: 1,
      current_files: 1,
      original_bytes: 8,
      current_bytes: 8,
      changed: false,
      change_reason: null,
      approval_credit: "full_source",
      coverage_proof: null,
    },
  });

  assert.equal(recovery.schema_version, 1);
  assert.equal(recovery.provider, "kimi");
  assert.equal(recovery.mode, "custom-review");
  assert.equal(recovery.source_content_transmission, "not_sent");
  assert.equal(recovery.provider_capabilities.supports_no_source_resume, false);
  assert.ok(!recovery.actions.some((action) => action.type === "resume_without_source_resend"));
  assert.deepEqual(
    recovery.actions.map((action) => action.type),
    ["resend_with_confirmation", "switch_provider", "waive_slot"],
  );
});

test("packet recovery omits shard action when no concrete shard plan exists", () => {
  const sourcePacketPolicy = evaluateSourcePacketPolicy({
    provider: "deepseek",
    mode: "custom-review",
    routeStep: "direct_api",
    providerCapabilities: {
      api: { source_packet: { max_bytes: 10 } },
    },
    selectedSource: selectedSourceFixture(11),
    sourceBearing: true,
  });

  const recovery = providerRoutePolicy.buildPacketRecovery({
    sourcePacketPolicy,
    providerCapabilities: {
      api: { source_packet: { max_bytes: 10 } },
    },
    reviewSurface: {
      original_packet_hash: null,
      current_packet_hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      original_files: null,
      current_files: 1,
      original_bytes: null,
      current_bytes: 11,
      changed: true,
      change_reason: "narrowed_scope",
      approval_credit: "changed_surface_only",
      coverage_proof: null,
    },
  });

  assert.equal(recovery.reason, "source_packet_too_large");
  assert.equal(recovery.source_content_transmission, "not_sent");
  assert.deepEqual(
    recovery.actions.map((action) => action.type),
    ["diff_packet", "allow_large_source_packet", "switch_provider", "waive_slot"],
  );
  for (const action of recovery.actions) {
    assert.notEqual(action.type, "shard");
    assert.notEqual(action.shards, []);
  }
});

test("packet recovery dispatches source packet reasons from the normalized reason", () => {
  const recovery = providerRoutePolicy.buildPacketRecovery({
    reason: "source_packet_too_large",
    provider: "deepseek",
    mode: "custom-review",
    routeStep: "direct_api",
    providerCapabilities: {
      api: { source_packet: { max_bytes: 10 } },
    },
    selectedSource: selectedSourceFixture(11),
    sourceContentTransmission: "not_sent",
  });

  assert.equal(recovery.reason, "source_packet_too_large");
  assert.deepEqual(
    recovery.actions.map((action) => action.type),
    ["diff_packet", "allow_large_source_packet", "switch_provider", "waive_slot"],
  );
});

test("packet recovery marks changed review surfaces as changed-surface approval only", () => {
  const recovery = providerRoutePolicy.buildPacketRecovery({
    reason: "prompt_too_large",
    provider: "deepseek",
    mode: "custom-review",
    routeStep: "direct_api",
    sourceContentTransmission: "not_sent",
    providerCapabilities: {
      api: { source_packet: { max_bytes: 512 * 1024 } },
    },
    previousSelectedSource: selectedSourceFixture(20),
    selectedSource: selectedSourceFixture(10),
  });

  assert.equal(recovery.review_surface.changed, true);
  assert.equal(recovery.review_surface.change_reason, "narrowed_scope");
  assert.equal(recovery.review_surface.approval_credit, "changed_surface_only");
  assert.equal(recovery.review_surface.coverage_proof, null);
  assert.notEqual(recovery.review_surface.original_packet_hash, recovery.review_surface.current_packet_hash);
});

test("packet recovery records prompt budget shards and capability metadata", async () => {
  for (const [name, target] of await providerRoutePolicyModules()) {
    const recovery = target.buildPacketRecovery({
      reason: "prompt_too_large",
      provider: "grok",
      mode: "custom-review",
      routeStep: "subscription",
      sourceContentTransmission: "not_sent",
      providerCapabilities: {
        subscription: {
          source_packet: {
            max_bytes: 512,
            resume_without_resend_supported: true,
          },
        },
      },
      renderedPromptBudgetChars: 1000,
      perFileSecureReadCapBytes: 256,
      supportsDiffPacket: false,
      requiresSourceSendApproval: true,
      transportFallbacks: ["web"],
      shardPlans: [
        Object.freeze({ index: 1, files: ["src/a.js"], prompt_bytes: 400 }),
        Object.freeze({ index: 2, files: ["src/b.js"], prompt_bytes: 350 }),
      ],
      previousSelectedSource: selectedSourceFixture(20),
      selectedSource: selectedSourceFixture(20),
    });

    assert.equal(recovery.reason, "prompt_too_large", name);
    assert.equal(recovery.provider_capabilities.rendered_prompt_budget_chars, 1000, name);
    assert.equal(recovery.provider_capabilities.per_file_secure_read_cap_bytes, 256, name);
    assert.equal(recovery.provider_capabilities.supports_diff_packet, false, name);
    assert.equal(recovery.provider_capabilities.supports_shard_plan, true, name);
    assert.equal(recovery.provider_capabilities.supports_no_source_resume, true, name);
    assert.equal(recovery.provider_capabilities.requires_source_send_approval, true, name);
    assert.deepEqual(recovery.provider_capabilities.transport_fallbacks, ["web"], name);
    assert.deepEqual(
      recovery.actions.map((action) => action.type),
      ["shard", "diff_packet", "switch_provider", "waive_slot"],
      name,
    );
    assert.equal(recovery.actions[0].approval_required, true, name);
    assert.equal(recovery.actions[0].review_surface_change, true, name);
    assert.equal(recovery.actions[0].shards.length, 2, name);
  }
});

test("packet recovery includes source-packet shards and no-source resume when supported", async () => {
  for (const [name, target] of await providerRoutePolicyModules()) {
    const sourcePacketPolicy = target.evaluateSourcePacketPolicy({
      provider: "claude",
      mode: "custom-review",
      routeStep: "subscription",
      providerCapabilities: {
        subscription: {
          source_packet: {
            max_bytes: 10,
            resume_without_resend_supported: true,
          },
        },
      },
      selectedSource: selectedSourceFixture(11),
      sourceBearing: true,
    });
    const tooLarge = target.buildPacketRecovery({
      sourcePacketPolicy,
      providerCapabilities: {
        subscription: {
          source_packet: {
            max_bytes: 10,
            resume_without_resend_supported: true,
          },
        },
      },
      requiresSourceSendApproval: true,
      shardPlans: [
        Object.freeze({ index: 1, files: ["src/one.js"], source_bytes: 5 }),
      ],
    });

    assert.deepEqual(
      tooLarge.actions.map((action) => action.type),
      ["shard", "diff_packet", "allow_large_source_packet", "switch_provider", "waive_slot"],
      name,
    );
    assert.equal(tooLarge.actions[0].approval_required, true, name);
    assert.equal(tooLarge.actions[0].shards[0].source_bytes, 5, name);

    const resend = target.buildPacketRecovery({
      reason: "resend_confirmation_required",
      provider: "claude",
      mode: "custom-review",
      routeStep: "subscription",
      providerCapabilities: {
        subscription: {
          source_packet: {
            max_bytes: 20,
            resume_without_resend_supported: true,
          },
        },
      },
    });

    assert.deepEqual(
      resend.actions.map((action) => action.type),
      ["resend_with_confirmation", "resume_without_source_resend", "switch_provider", "waive_slot"],
      name,
    );
  }
});

test("packet recovery falls back to switch or waiver for unknown packet failures", async () => {
  for (const [name, target] of await providerRoutePolicyModules()) {
    const recovery = target.buildPacketRecovery({
      reason: "provider_crashed_after_source_send",
      provider: "glm",
      mode: "custom-review",
      routeStep: "direct_api",
      sourceContentTransmission: "may_be_sent",
      providerCapabilities: {
        api: { source_packet: { max_bytes: 1024 } },
      },
      supportsShardPlan: false,
      requiresResendConfirmationAfterSourceSentFailure: false,
    });

    assert.equal(recovery.reason, "provider_crashed_after_source_send", name);
    assert.equal(recovery.source_content_transmission, "may_be_sent", name);
    assert.equal(recovery.provider_capabilities.supports_shard_plan, false, name);
    assert.equal(recovery.provider_capabilities.requires_resend_confirmation_after_source_sent_failure, false, name);
    assert.deepEqual(
      recovery.actions.map((action) => action.type),
      ["switch_provider", "waive_slot"],
      name,
    );
    assert.equal(recovery.actions[1].approval_required, true, name);
  }
});

test("packet recovery capabilities distinguish local pre-send policy from post-launch runtime failures", () => {
  const sourcePacketPolicy = evaluateSourcePacketPolicy({
    provider: "claude",
    mode: "custom-review",
    routeStep: "subscription",
    providerCapabilities: {
      subscription: { source_packet: { max_bytes: 1024 } },
    },
    selectedSource: selectedSourceFixture(12),
    sourceBearing: true,
  });

  const recovery = providerRoutePolicy.buildPacketRecovery({
    reason: "timeout",
    sourcePacketPolicy,
    providerCapabilities: {
      subscription: { source_packet: { max_bytes: 1024 } },
    },
    provider: "claude",
    mode: "custom-review",
    routeStep: "subscription",
    sourceContentTransmission: "sent",
  });

  assert.equal(recovery.provider_capabilities.local_source_packet_policy_pre_send, true);
  assert.equal(recovery.provider_capabilities.source_sent_runtime_failures_failed_slot, true);
});

test("source packet policy permits explicit large packet override for every provider and route step", () => {
  const contract = buildProviderPolicyContract();

  for (const provider of contract.providers) {
    for (const routeStep of PROVIDER_ROUTE_STEPS) {
      const policy = evaluateSourcePacketPolicy({
        provider,
        mode: "custom-review",
        routeStep,
        providerCapabilities: {
          subscription: { source_packet: { max_bytes: 10 } },
          api: { source_packet: { max_bytes: 10 } },
          openrouter: { source_packet: { max_bytes: 10 } },
        },
        selectedSource: selectedSourceFixture(11),
        sourceBearing: true,
        sourcePacketOverrideApproved: true,
        sourcePacketOverrideSource: "--allow-large-source-packet",
      });

      assert.equal(policy.provider, provider);
      assert.equal(policy.route_step, routeStep);
      assert.equal(policy.source_send_allowed, true);
      assert.equal(policy.source_packet_action, "send_after_source_packet_override");
      assert.equal(policy.source_packet_policy_error_code, null);
      assert.equal(policy.source_content_transmission, "may_be_sent");
      assert.equal(policy.source_packet_budget_bytes, 10);
      assert.equal(policy.selected_source_bytes, 11);
      assert.equal(policy.source_packet_within_budget, false);
      assert.equal(policy.source_packet_override_approved, true);
      assert.equal(policy.source_packet_override_source, "--allow-large-source-packet");
      assert.equal(policy.resend_confirmation_required, false);
    }
  }
});

test("source packet policy records unknown override source when approval source is absent", async () => {
  for (const [name, target] of await providerRoutePolicyModules()) {
    const policy = target.evaluateSourcePacketPolicy({
      provider: "glm",
      mode: "custom-review",
      routeStep: "direct_api",
      providerCapabilities: {
        api: { source_packet: { max_bytes: 10 } },
      },
      selectedSource: selectedSourceFixture(11),
      sourceBearing: true,
      sourcePacketOverrideApproved: true,
    });

    assert.equal(policy.source_send_allowed, true, name);
    assert.equal(policy.source_packet_action, "send_after_source_packet_override", name);
    assert.equal(policy.source_packet_override_source, "unknown", name);
    assert.match(policy.suggested_action, /approved large source packet/, name);
  }
});

test("source packet policy prevents automatic resend after source-bearing failure unless confirmed or narrowed", () => {
  const previousAttempt = {
    status: "failed",
    error_code: "timeout",
    source_content_transmission: "sent",
    selected_source: selectedSourceFixture(8),
  };
  const baseInput = {
    provider: "kimi",
    mode: "custom-review",
    routeStep: "subscription",
    providerCapabilities: {
      subscription: { source_packet: { max_bytes: 20 } },
    },
    selectedSource: selectedSourceFixture(8),
    sourceBearing: true,
    previousAttempt,
  };

  const blocked = evaluateSourcePacketPolicy(baseInput);
  assert.equal(blocked.source_send_allowed, false);
  assert.equal(blocked.source_packet_action, "resend_confirmation_required");
  assert.equal(blocked.source_packet_policy_error_code, "resend_confirmation_required");
  assert.equal(blocked.resend_confirmation_required, true);
  assert.equal(blocked.review_surface_changed, false);
  assert.equal(blocked.source_content_transmission, "not_sent");

  const overrideStillBlocked = evaluateSourcePacketPolicy({
    ...baseInput,
    providerCapabilities: {
      subscription: { source_packet: { max_bytes: 7 } },
    },
    sourcePacketOverrideApproved: true,
    sourcePacketOverrideSource: "--allow-large-source-packet",
  });
  assert.equal(overrideStillBlocked.source_send_allowed, false);
  assert.equal(overrideStillBlocked.source_packet_action, "resend_confirmation_required");
  assert.equal(overrideStillBlocked.source_packet_policy_error_code, "resend_confirmation_required");
  assert.equal(overrideStillBlocked.source_packet_within_budget, false);
  assert.equal(overrideStillBlocked.source_packet_override_approved, true);
  assert.equal(overrideStillBlocked.source_packet_override_source, "--allow-large-source-packet");
  assert.equal(overrideStillBlocked.resend_confirmation_required, true);
  assert.equal(overrideStillBlocked.source_content_transmission, "not_sent");

  const confirmed = evaluateSourcePacketPolicy({
    ...baseInput,
    resendConfirmationApproved: true,
  });
  assert.equal(confirmed.source_send_allowed, true);
  assert.equal(confirmed.source_packet_action, "send_after_resend_confirmation");
  assert.equal(confirmed.resend_confirmation_required, false);

  const narrowed = evaluateSourcePacketPolicy({
    ...baseInput,
    selectedSource: selectedSourceFixture(4),
  });
  assert.equal(narrowed.source_send_allowed, true);
  assert.equal(narrowed.source_packet_action, "send_narrowed_source_packet");
  assert.equal(narrowed.resend_confirmation_required, false);
  assert.equal(narrowed.review_surface_changed, true);
});

test("source packet retry policy derives previous attempts from JobRecords", () => {
  const previousAttempt = sourcePacketPreviousAttemptFromJobRecord({
    started_at: "2026-05-29T01:00:00.000Z",
    status: "failed",
    error_code: "review_not_completed",
    external_review: { source_content_transmission: "sent" },
    review_metadata: {
      audit_manifest: {
        selected_source: selectedSourceFixture(8),
      },
    },
  });
  assert.equal(previousAttempt.started_at, "2026-05-29T01:00:00.000Z");

  const policy = evaluateSourcePacketPolicy({
    provider: "claude",
    mode: "custom-review",
    routeStep: "subscription",
    providerCapabilities: {
      subscription: { source_packet: { max_bytes: 20 } },
    },
    selectedSource: selectedSourceFixture(8),
    sourceBearing: true,
    previousAttempt,
  });

  assert.equal(policy.source_send_allowed, false);
  assert.equal(policy.source_packet_action, "resend_confirmation_required");
  assert.equal(policy.source_packet_policy_error_code, "resend_confirmation_required");
});

test("source packet retry policy allows same-session resume without source resend after step limits", () => {
  const previousRecord = {
    status: "failed",
    error_code: "step_limit_exceeded",
    external_review: { source_content_transmission: "sent" },
    review_metadata: {
      audit_manifest: {
        selected_source: selectedSourceFixture(8),
      },
    },
  };
  const previousAttempt = sourcePacketPreviousAttemptFromJobRecord(previousRecord);

  assert.equal(sourcePacketCanResumeWithoutResendFromJobRecord(previousRecord), true);

  const policy = evaluateSourcePacketPolicy({
    provider: "kimi",
    mode: "custom-review",
    routeStep: "subscription",
    providerCapabilities: {
      subscription: { source_packet: { max_bytes: 20 } },
    },
    selectedSource: Object.freeze({
      files: Object.freeze([]),
      totals: Object.freeze({ files: 0, bytes: 0, lines: 0 }),
    }),
    sourceBearing: true,
    previousAttempt,
    resumeWithoutSourceResend: true,
  });

  assert.equal(policy.source_send_allowed, true);
  assert.equal(policy.source_packet_action, "resume_without_source_resend");
  assert.equal(policy.source_content_transmission, "not_sent");
  assert.equal(policy.resume_without_source_resend, true);
  assert.equal(policy.resend_confirmation_required, false);
});

test("source packet retry policy blocks no-source repair when adapter cannot retain prior source", () => {
  const previousRecord = {
    status: "failed",
    error_code: "step_limit_exceeded",
    external_review: { source_content_transmission: "sent" },
    review_metadata: {
      audit_manifest: {
        selected_source: selectedSourceFixture(8),
      },
    },
  };
  const previousAttempt = sourcePacketPreviousAttemptFromJobRecord(previousRecord);

  assert.equal(sourcePacketCanResumeWithoutResendFromJobRecord(previousRecord), true);

  const policy = evaluateSourcePacketPolicy({
    provider: "kimi",
    mode: "custom-review",
    routeStep: "subscription",
    providerCapabilities: {
      subscription: {
        source_packet: {
          max_bytes: 20,
          resume_without_resend_supported: false,
        },
      },
    },
    selectedSource: Object.freeze({
      files: Object.freeze([]),
      totals: Object.freeze({ files: 0, bytes: 0, lines: 0 }),
    }),
    sourceBearing: true,
    previousAttempt,
    resumeWithoutSourceResend: true,
  });

  assert.equal(policy.source_send_allowed, false);
  assert.equal(policy.source_packet_action, "resend_confirmation_required");
  assert.equal(policy.source_packet_policy_error_code, "resend_confirmation_required");
  assert.equal(policy.source_content_transmission, "not_sent");
  assert.equal(policy.resume_without_source_resend, true);
  assert.equal(policy.resend_confirmation_required, true);
});

test("source packet retry policy allows no-source repair after substantive invalid verdict prose", () => {
  const previousRecord = {
    status: "failed",
    error_code: "review_not_completed",
    error_message: "review_quality_failed:missing_verdict",
    external_review: { source_content_transmission: "sent" },
    review_metadata: {
      audit_manifest: {
        selected_source: selectedSourceFixture(8),
        review_quality: {
          failed_review_slot: true,
          semantic_failure_reasons: ["missing_verdict"],
        },
      },
    },
  };
  const previousAttempt = sourcePacketPreviousAttemptFromJobRecord(previousRecord);

  assert.equal(sourcePacketCanResumeWithoutResendFromJobRecord(previousRecord), true);
  assert.deepEqual(previousAttempt.review_quality.semantic_failure_reasons, ["missing_verdict"]);

  const policy = evaluateSourcePacketPolicy({
    provider: "kimi",
    mode: "custom-review",
    routeStep: "subscription",
    providerCapabilities: {
      subscription: { source_packet: { max_bytes: 20 } },
    },
    selectedSource: Object.freeze({
      files: Object.freeze([]),
      totals: Object.freeze({ files: 0, bytes: 0, lines: 0 }),
    }),
    sourceBearing: true,
    previousAttempt,
    resumeWithoutSourceResend: true,
  });

  assert.equal(policy.source_send_allowed, true);
  assert.equal(policy.source_packet_action, "resume_without_source_resend");
  assert.equal(policy.source_content_transmission, "not_sent");
  assert.equal(policy.selected_source_bytes, 0);
});

test("source packet retry policy carries original source attempt through failed no-source repairs", () => {
  const originalRecord = {
    status: "failed",
    error_code: "review_not_completed",
    error_message: "review_quality_failed:missing_verdict",
    external_review: { source_content_transmission: "sent" },
    review_metadata: {
      audit_manifest: {
        selected_source: selectedSourceFixture(8),
        review_quality: {
          failed_review_slot: true,
          semantic_failure_reasons: ["missing_verdict"],
        },
      },
    },
  };
  const originalAttempt = sourcePacketPreviousAttemptFromJobRecord(originalRecord);
  const failedNoSourceRepair = {
    status: "failed",
    error_code: "review_not_completed",
    error_message: "review_quality_failed:missing_verdict",
    external_review: { source_content_transmission: "not_sent" },
    review_metadata: {
      audit_manifest: {
        selected_source: Object.freeze({
          files: Object.freeze([]),
          totals: Object.freeze({ files: 0, bytes: 0, lines: 0 }),
        }),
        review_quality: {
          failed_review_slot: true,
          semantic_failure_reasons: ["missing_verdict"],
        },
      },
    },
  };

  const continuationAttempt = sourcePacketPreviousAttemptForContinuation(
    failedNoSourceRepair,
    { previous_source_attempt: originalAttempt },
  );

  assert.equal(sourcePacketCanResumeWithoutResendFromPreviousAttempt(continuationAttempt), true);
  assert.equal(continuationAttempt.selected_source.totals.bytes, 8);

  const policy = evaluateSourcePacketPolicy({
    provider: "kimi",
    mode: "custom-review",
    routeStep: "subscription",
    providerCapabilities: {
      subscription: { source_packet: { max_bytes: 20 } },
    },
    selectedSource: Object.freeze({
      files: Object.freeze([]),
      totals: Object.freeze({ files: 0, bytes: 0, lines: 0 }),
    }),
    sourceBearing: true,
    previousAttempt: continuationAttempt,
    resumeWithoutSourceResend: true,
  });

  assert.equal(policy.source_packet_action, "resume_without_source_resend");
  assert.equal(policy.source_content_transmission, "not_sent");
});

test("source packet retry policy blocks source resend after shallow missing verdict output", () => {
  const previousRecord = {
    status: "failed",
    error_code: "review_not_completed",
    error_message: "review_quality_failed:shallow_output,missing_verdict",
    external_review: { source_content_transmission: "sent" },
    review_metadata: {
      audit_manifest: {
        selected_source: selectedSourceFixture(8),
        review_quality: {
          failed_review_slot: true,
          semantic_failure_reasons: ["shallow_output", "missing_verdict"],
        },
      },
    },
  };

  assert.equal(sourcePacketCanResumeWithoutResendFromJobRecord(previousRecord), false);

  const policy = evaluateSourcePacketPolicy({
    provider: "kimi",
    mode: "custom-review",
    routeStep: "subscription",
    providerCapabilities: {
      subscription: { source_packet: { max_bytes: 20 } },
    },
    selectedSource: selectedSourceFixture(8),
    sourceBearing: true,
    previousAttempt: sourcePacketPreviousAttemptFromJobRecord(previousRecord),
    resumeWithoutSourceResend: true,
  });

  assert.equal(policy.source_send_allowed, false);
  assert.equal(policy.source_packet_action, "resend_confirmation_required");
  assert.equal(policy.source_content_transmission, "not_sent");
});

test("packaged provider route policy copies cover shared source-packet and route branches", async () => {
  const modules = await Promise.all(
    REVIEW_PROMPT_PLUGIN_TARGETS.map(async (plugin) => [
      plugin,
      await import(`../../plugins/${plugin}/scripts/lib/provider-route-policy.mjs`),
    ]),
  );

  for (const [plugin, mod] of modules) {
    assert.deepEqual(mod.PROVIDER_ROUTE_STEPS, PROVIDER_ROUTE_STEPS, plugin);
    assert.deepEqual(mod.buildProviderPolicyContract().providers, buildProviderPolicyContract().providers, plugin);
    assert.equal(mod.sourcePacketPreviousAttemptFromJobRecord(null), null, plugin);
    assert.equal(mod.sourcePacketPreviousAttemptFromJobRecord({ review_metadata: { audit_manifest: {} } }), null, plugin);
    assert.equal(mod.sourcePacketCanResumeWithoutResendFromJobRecord(null), false, plugin);

    const previousStepLimitRecord = {
      status: "failed",
      review_metadata: {
        audit_manifest: {
          error_code: "step_limit_exceeded",
          source_content_transmission: "sent_after_explicit_approval",
          selected_source: selectedSourceFixture(12),
        },
      },
    };
    const previousStepLimit = mod.sourcePacketPreviousAttemptFromJobRecord(previousStepLimitRecord);
    assert.equal(previousStepLimit.error_code, "step_limit_exceeded", plugin);
    assert.equal(previousStepLimit.source_content_transmission, "sent_after_explicit_approval", plugin);
    assert.equal(mod.sourcePacketCanResumeWithoutResendFromJobRecord(previousStepLimitRecord), true, plugin);

    const previousTimeout = {
      status: "failed",
      reason: "timeout",
      source_sent: true,
      source_packet: selectedSourceFixture(12),
    };
    assert.equal(mod.sourcePacketCanResumeWithoutResendFromJobRecord({
      status: "failed",
      error_code: "timeout",
      external_review: { source_content_transmission: "sent" },
      review_metadata: {
        audit_manifest: {
          selected_source: selectedSourceFixture(12),
        },
      },
    }), false, plugin);

    const previousInvalidVerdictRecord = {
      status: "failed",
      error_code: "review_not_completed",
      error_message: "review_quality_failed:bad_verdict",
      external_review: { source_content_transmission: "sent" },
      review_metadata: {
        audit_manifest: {
          selected_source: selectedSourceFixture(12),
          review_quality: {
            failed_review_slot: true,
            semantic_failure_reasons: ["bad_verdict"],
          },
        },
      },
    };
    const previousInvalidVerdict = mod.sourcePacketPreviousAttemptFromJobRecord(previousInvalidVerdictRecord);
    assert.equal(mod.sourcePacketCanResumeWithoutResendFromJobRecord(previousInvalidVerdictRecord), true, plugin);

    const failedNoSourceRepair = {
      status: "failed",
      error_code: "review_not_completed",
      error_message: "review_quality_failed:bad_verdict",
      external_review: { source_content_transmission: "not_sent" },
      review_metadata: {
        audit_manifest: {
          selected_source: { files: [], totals: { files: 0, bytes: 0, lines: 0 } },
          review_quality: {
            failed_review_slot: true,
            semantic_failure_reasons: ["bad_verdict"],
          },
        },
      },
    };
    const carriedInvalidVerdict = mod.sourcePacketPreviousAttemptForContinuation(
      failedNoSourceRepair,
      { previous_source_attempt: previousInvalidVerdict },
    );
    assert.equal(mod.sourcePacketCanResumeWithoutResendFromPreviousAttempt(carriedInvalidVerdict), true, plugin);
    assert.equal(carriedInvalidVerdict.selected_source.totals.bytes, 12, plugin);

    const previousShallowVerdictRecord = {
      status: "failed",
      error_code: "review_not_completed",
      error_message: "review_quality_failed:shallow_output,missing_verdict",
      external_review: { source_content_transmission: "sent" },
      review_metadata: {
        audit_manifest: {
          selected_source: selectedSourceFixture(12),
          review_quality: {
            failed_review_slot: true,
            semantic_failure_reasons: ["shallow_output", "missing_verdict"],
          },
        },
      },
    };
    assert.equal(mod.sourcePacketCanResumeWithoutResendFromJobRecord(previousShallowVerdictRecord), false, plugin);

    assert.deepEqual(mod.evaluateSourcePacketPolicy({
      provider: plugin,
      mode: "setup",
      routeStep: "subscription",
      providerCapabilities: {
        source_packet: { max_bytes: 64 },
      },
      selectedSource: null,
      sourceBearing: false,
    }), {
      provider: plugin,
      mode: "setup",
      route_step: "subscription",
      source_bearing: false,
      source_packet_budget_bytes: 64,
      selected_source_bytes: 0,
      source_packet_within_budget: true,
      source_packet_override_approved: false,
      source_packet_override_source: null,
      resend_confirmation_required: false,
      resume_without_source_resend: false,
      review_surface_changed: false,
      source_packet_policy_error_code: null,
      suggested_action: null,
      source_send_allowed: true,
      source_packet_action: "not_source_bearing",
      source_content_transmission: "not_sent",
    }, plugin);

    assert.throws(
      () => mod.evaluateSourcePacketPolicy({
        provider: plugin,
        routeStep: "subscription",
        providerCapabilities: {
          subscription: { source_packet: { max_bytes: 0 } },
        },
        selectedSource: selectedSourceFixture(1),
        sourceBearing: true,
      }),
      /source packet max_bytes must be a positive integer/,
      plugin,
    );

    const tooLarge = mod.evaluateSourcePacketPolicy({
      provider: plugin,
      mode: "custom-review",
      routeStep: "subscription",
      providerCapabilities: {
        subscription: { source_packet: { max_bytes: 10 } },
      },
      selectedSource: selectedSourceFixture(11),
      sourceBearing: true,
    });
    assert.equal(tooLarge.source_send_allowed, false, plugin);
    assert.equal(tooLarge.source_packet_action, "narrow_source_packet", plugin);
    assert.match(tooLarge.suggested_action, /Narrow or shard/, plugin);

    const override = mod.evaluateSourcePacketPolicy({
      provider: plugin,
      mode: "custom-review",
      routeStep: "subscription",
      providerCapabilities: {
        subscription: { source_packet: { max_bytes: 10 } },
      },
      selectedSource: selectedSourceFixture(11),
      sourceBearing: true,
      sourcePacketOverrideApproved: true,
      sourcePacketOverrideSource: "--allow-large-source-packet",
    });
    assert.equal(override.source_send_allowed, true, plugin);
    assert.equal(override.source_packet_action, "send_after_source_packet_override", plugin);
    assert.equal(override.source_packet_override_approved, true, plugin);
    assert.equal(override.source_packet_override_source, "--allow-large-source-packet", plugin);

    const blocked = mod.evaluateSourcePacketPolicy({
      provider: plugin,
      mode: "custom-review",
      routeStep: "subscription",
      providerCapabilities: {
        subscription: { source_packet: { max_bytes: 32 } },
      },
      selectedSource: selectedSourceFixture(12),
      sourceBearing: true,
      previousAttempt: previousTimeout,
      resumeWithoutSourceResend: true,
    });
    assert.equal(blocked.source_packet_action, "resend_confirmation_required", plugin);
    assert.equal(blocked.resend_confirmation_required, true, plugin);

    const resumed = mod.evaluateSourcePacketPolicy({
      provider: plugin,
      mode: "custom-review",
      routeStep: "subscription",
      providerCapabilities: {
        subscription: { source_packet: { max_bytes: 32 } },
      },
      selectedSource: { files: [], totals: { files: 0, bytes: 0, lines: 0 } },
      sourceBearing: true,
      previousAttempt: previousStepLimit,
      resumeWithoutSourceResend: true,
    });
    assert.equal(resumed.source_packet_action, "resume_without_source_resend", plugin);
    assert.equal(resumed.source_content_transmission, "not_sent", plugin);

    const invalidVerdictRepair = mod.evaluateSourcePacketPolicy({
      provider: plugin,
      mode: "custom-review",
      routeStep: "subscription",
      providerCapabilities: {
        subscription: { source_packet: { max_bytes: 32 } },
      },
      selectedSource: { files: [], totals: { files: 0, bytes: 0, lines: 0 } },
      sourceBearing: true,
      previousAttempt: previousInvalidVerdict,
      resumeWithoutSourceResend: true,
    });
    assert.equal(invalidVerdictRepair.source_packet_action, "resume_without_source_resend", plugin);
    assert.equal(invalidVerdictRepair.source_content_transmission, "not_sent", plugin);

    const narrowed = mod.evaluateSourcePacketPolicy({
      provider: plugin,
      mode: "custom-review",
      routeStep: "subscription",
      providerCapabilities: {
        subscription: { source_packet: { max_bytes: 32 } },
      },
      selectedSource: selectedSourceFixture(4),
      sourceBearing: true,
      previousAttempt: previousTimeout,
    });
    assert.equal(narrowed.source_packet_action, "send_narrowed_source_packet", plugin);
    assert.equal(narrowed.review_surface_changed, true, plugin);

    const confirmed = mod.evaluateSourcePacketPolicy({
      provider: plugin,
      mode: "custom-review",
      routeStep: "subscription",
      providerCapabilities: {
        subscription: { source_packet: { max_bytes: 32 } },
      },
      selectedSource: selectedSourceFixture(12),
      sourceBearing: true,
      previousAttempt: previousTimeout,
      resendConfirmationApproved: true,
    });
    assert.equal(confirmed.source_packet_action, "send_after_resend_confirmation", plugin);

    const sent = mod.evaluateSourcePacketPolicy({
      provider: plugin,
      mode: "custom-review",
      routeStep: "direct_api",
      providerCapabilities: {
        api: { source_packet: { max_bytes: 32 } },
      },
      selectedSource: selectedSourceFixture(12),
      sourceBearing: true,
    });
    assert.equal(sent.source_packet_action, "send", plugin);

    assert.equal(mod.normalizeApprovalScope("once"), "once", plugin);
    const badApproval = [];
    assert.equal(mod.normalizeApprovalScope("auto", (code, message) => badApproval.push({ code, message })), null, plugin);
    assert.deepEqual(badApproval.map((failure) => failure.code), ["bad_args"], plugin);

    const badRoute = [];
    assert.equal(mod.selectProviderRoute({
      requestedRoute: "auto",
      providerCapabilities: subscriptionAndApi,
      env: {},
      fail: (code, message) => badRoute.push({ code, message }),
    }), null, plugin);
    assert.deepEqual(badRoute.map((failure) => failure.code), ["bad_args"], plugin);

    assert.deepEqual(mod.selectProviderRoute({
      requestedRoute: "openrouter",
      fallbackReason: "explicit_openrouter",
      providerCapabilities: allCapabilities,
      env: { OPENROUTER_API_KEY: "openrouter-secret" },
      sourceBearing: false,
    }).route_steps.map((step) => step.route), PROVIDER_ROUTE_STEPS, plugin);

    assert.throws(
      () => mod.selectProviderRoute({ requestedRoute: "openrouter", providerCapabilities: subscriptionOnly, env: {} }),
      /provider has no supported capability/,
      plugin,
    );
    assert.throws(
      () => mod.selectProviderRoute({
        requestedRoute: "api",
        fallbackReason: "bogus",
        providerCapabilities: allCapabilities,
        env: { PROVIDER_API_KEY: "secret" },
      }),
      /unsupported route fallback reason/,
      plugin,
    );
  }
});

test("review audit manifest records shared route and source packet policy fields", () => {
  const route = selectProviderRoute({
    requestedRoute: undefined,
    providerCapabilities: subscriptionAndApi,
    env: { PROVIDER_API_KEY: "secret" },
    sourceBearing: true,
  });
  const manifest = buildReviewAuditManifest({
    prompt: "Review selected source.",
    sourceFiles: [{ path: "src/example.js", text: "console.log(1);\n" }],
    request: { provider: "Claude Code", model: "opus" },
    route: {
      selectedRoute: route.selected_route,
      routeStep: route.route_step,
      routeSteps: route.route_steps,
      fallbackReason: route.fallback_reason,
      sourceBearing: true,
      sourcePacketPolicy: evaluateSourcePacketPolicy({
        provider: "claude",
        mode: "custom-review",
        routeStep: route.route_step,
        providerCapabilities: {
          subscription: { source_packet: { max_bytes: 100 } },
        },
        selectedSource: selectedSourceFixture(16),
        sourceBearing: true,
      }),
    },
  });

  assert.equal(manifest.route_step, "subscription");
  assertRouteStepLedger({ route_steps: manifest.route_steps });
  assert.equal(manifest.source_packet_policy.source_send_allowed, true);
  assert.equal(manifest.source_packet_policy.source_packet_action, "send");
  assert.equal(manifest.source_packet_policy.selected_source_bytes, 16);
});

test("review audit manifest enforces route provider source packet capabilities", () => {
  const manifest = buildReviewAuditManifest({
    prompt: "Review selected source.",
    sourceFiles: [{ path: "src/large.js", text: "x".repeat(11) }],
    request: { provider: "grok", model: "reviewer" },
    route: {
      selectedRoute: "subscription_cli",
      routeStep: "subscription",
      routeSteps: [],
      sourceBearing: true,
      providerCapabilities: {
        subscription: { source_packet: { max_bytes: 10 } },
      },
    },
  });

  assert.equal(manifest.source_packet_policy.source_send_allowed, false);
  assert.equal(manifest.source_packet_policy.source_packet_action, "narrow_source_packet");
  assert.equal(manifest.source_packet_policy.source_packet_policy_error_code, "source_packet_too_large");
  assert.equal(manifest.source_packet_policy.source_packet_budget_bytes, 10);
  assert.equal(manifest.source_packet_policy.selected_source_bytes, 11);
});

test("provider route policy defaults subscription-capable providers to subscription and ignores API keys", () => {
  const route = selectProviderRoute({
    requestedRoute: undefined,
    providerCapabilities: subscriptionAndApi,
    env: { PROVIDER_API_KEY: "secret" },
    sourceBearing: true,
  });

  assert.deepEqual(route, {
    route_mode: "subscription",
    selected_route: "subscription_oauth",
    route_step: "subscription",
    auth_path: "subscription_oauth",
    billing_path: null,
    fallback_reason: null,
    allowed_env_credentials: [],
    ignored_env_credentials: ["PROVIDER_API_KEY"],
    source_send_approval_required: false,
    source_send_approval_state: "not_required",
    route_steps: [
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
    ],
  });
  assertRouteStepLedger(route);
});

test("provider route policy applies one ladder shape to every named provider", () => {
  const contract = buildProviderPolicyContract();
  const providerCapabilities = {
    claude: subscriptionAndApi,
    gemini: subscriptionAndApi,
    kimi: subscriptionOnly,
    grok: subscriptionOnly,
    deepseek: apiOnly,
    glm: apiOnly,
  };
  const env = {
    PROVIDER_API_KEY: "secret",
    API_ONLY_KEY: "secret",
  };

  assert.deepEqual(Object.keys(providerCapabilities).sort(), [...contract.providers].sort());
  for (const provider of contract.providers) {
    const route = selectProviderRoute({
      requestedRoute: undefined,
      providerCapabilities: providerCapabilities[provider],
      env,
      sourceBearing: true,
    });

    assertRouteStepLedger(route);
    assert.deepEqual(route.route_steps.map((step) => step.route), PROVIDER_ROUTE_STEPS);
    if (provider === "deepseek" || provider === "glm") {
      assert.equal(route.route_step, "direct_api", `${provider} should select direct_api through capability facts`);
      assert.equal(route.fallback_reason, "subscription_not_supported");
    } else {
      assert.equal(route.route_step, "subscription", `${provider} should select subscription through capability facts`);
      assert.equal(route.fallback_reason, null);
    }
  }
});

test("provider route policy handles subscription-only providers without API credential state", () => {
  const route = selectProviderRoute({
    requestedRoute: undefined,
    providerCapabilities: subscriptionOnly,
    env: { PROVIDER_API_KEY: "secret" },
    sourceBearing: true,
  });

  assert.deepEqual(route, {
    route_mode: "subscription",
    selected_route: "subscription_oauth",
    route_step: "subscription",
    auth_path: "subscription_oauth",
    billing_path: null,
    fallback_reason: null,
    allowed_env_credentials: [],
    ignored_env_credentials: [],
    source_send_approval_required: false,
    source_send_approval_state: "not_required",
    route_steps: [
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
        supported: false,
        attempted: true,
        selected: false,
        skipped_reason: "unsupported",
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
    ],
  });
  assertRouteStepLedger(route);
});

test("provider route policy uses the same API fallback state for providers without subscription transport", () => {
  const route = selectProviderRoute({
    requestedRoute: undefined,
    providerCapabilities: apiOnly,
    env: { API_ONLY_KEY: "secret" },
    sourceBearing: true,
  });

  assert.deepEqual(route, {
    route_mode: "api",
    route_step: "direct_api",
    selected_route: "direct_api",
    auth_path: "api_key_env",
    billing_path: { endpoint: "https://api-only.example.invalid", model: "review-model" },
    fallback_reason: "subscription_not_supported",
    allowed_env_credentials: ["API_ONLY_KEY"],
    ignored_env_credentials: [],
    source_send_approval_required: true,
    source_send_approval_state: "required",
    route_steps: [
      {
        route: "subscription",
        supported: false,
        attempted: true,
        selected: false,
        skipped_reason: "unsupported",
        fallback_reason: "subscription_not_supported",
      },
      {
        route: "direct_api",
        supported: true,
        attempted: true,
        selected: true,
        skipped_reason: null,
        fallback_reason: "subscription_not_supported",
      },
      {
        route: "openrouter",
        supported: false,
        attempted: true,
        selected: false,
        skipped_reason: "unsupported",
        fallback_reason: null,
      },
    ],
  });
  assertRouteStepLedger(route);
});

test("provider route policy allows API fallback only with explicit shared fallback reason", () => {
  const route = selectProviderRoute({
    requestedRoute: "api",
    fallbackReason: "usage_limited",
    providerCapabilities: subscriptionAndApi,
    env: { PROVIDER_API_KEY: "secret" },
    sourceBearing: true,
    sourceSendApproved: true,
  });

  assert.deepEqual(route, {
    route_mode: "api",
    route_step: "direct_api",
    selected_route: "direct_api",
    auth_path: "api_key_env",
    billing_path: { endpoint: "https://api.example.invalid", model: "review-model" },
    fallback_reason: "usage_limited",
    allowed_env_credentials: ["PROVIDER_API_KEY"],
    ignored_env_credentials: [],
    source_send_approval_required: true,
    source_send_approval_state: "approved",
    route_steps: [
      {
        route: "subscription",
        supported: true,
        attempted: true,
        selected: false,
        skipped_reason: "not_requested",
        fallback_reason: "usage_limited",
      },
      {
        route: "direct_api",
        supported: true,
        attempted: true,
        selected: true,
        skipped_reason: null,
        fallback_reason: "usage_limited",
      },
      {
        route: "openrouter",
        supported: false,
        attempted: true,
        selected: false,
        skipped_reason: "unsupported",
        fallback_reason: null,
      },
    ],
  });
  assertRouteStepLedger(route);
});

test("provider route policy falls through the same ladder to OpenRouter", () => {
  const route = selectProviderRoute({
    requestedRoute: undefined,
    providerCapabilities: openRouterOnly,
    env: { OPENROUTER_API_KEY: "secret" },
    sourceBearing: true,
  });

  assert.equal(route.route_mode, "openrouter");
  assert.equal(route.route_step, "openrouter");
  assert.equal(route.selected_route, "openrouter");
  assert.equal(route.auth_path, "openrouter_api_key_env");
  assert.deepEqual(route.billing_path, { endpoint: "https://openrouter.ai/api/v1", model: "provider/review-model" });
  assert.equal(route.fallback_reason, "direct_api_not_supported");
  assert.deepEqual(route.allowed_env_credentials, ["OPENROUTER_API_KEY"]);
  assert.equal(route.source_send_approval_required, true);
  assert.equal(route.source_send_approval_state, "required");
  assertRouteStepLedger(route);
  assert.deepEqual(route.route_steps, [
    {
      route: "subscription",
      supported: false,
      attempted: true,
      selected: false,
      skipped_reason: "unsupported",
      fallback_reason: "subscription_not_supported",
    },
    {
      route: "direct_api",
      supported: false,
      attempted: true,
      selected: false,
      skipped_reason: "unsupported",
      fallback_reason: "direct_api_not_supported",
    },
    {
      route: "openrouter",
      supported: true,
      attempted: true,
      selected: true,
      skipped_reason: null,
      fallback_reason: "direct_api_not_supported",
    },
  ]);
});

test("provider route policy records skipped OpenRouter route when direct API is selected", () => {
  const route = selectProviderRoute({
    requestedRoute: "api",
    providerCapabilities: allCapabilities,
    env: {
      PROVIDER_API_KEY: "secret",
      OPENROUTER_API_KEY: "openrouter-secret",
    },
    sourceBearing: true,
  });

  assert.equal(route.route_step, "direct_api");
  assert.deepEqual(route.ignored_env_credentials, ["OPENROUTER_API_KEY"]);
  assert.deepEqual(route.route_steps.at(-1), {
    route: "openrouter",
    supported: true,
    attempted: true,
    selected: false,
    skipped_reason: "not_needed",
    fallback_reason: null,
  });
});

test("provider route policy rejects ambiguous operator-facing auto route", () => {
  assert.throws(
    () => selectProviderRoute({
      requestedRoute: "auto",
      providerCapabilities: subscriptionAndApi,
      env: { PROVIDER_API_KEY: "secret" },
      sourceBearing: true,
    }),
    /route mode must be subscription, api, direct_api, or openrouter; got "auto"/,
  );
});

test("provider route policy normalizes provider-neutral approval scopes", () => {
  assert.equal(normalizeApprovalScope(undefined), "session");
  assert.equal(normalizeApprovalScope("session"), "session");
  assert.equal(normalizeApprovalScope("once"), "once");
  assert.throws(
    () => normalizeApprovalScope("auto"),
    /approval scope must be session or once; got "auto"/,
  );
});

test("shared_state concurrency admission forces limit 1 and rejects higher declared limits", (t) => {
  const sharedStateDir = mkdtempSync(path.join(tmpdir(), "relay-policy-shared-state-"));
  t.after(() => rmSync(sharedStateDir, { recursive: true, force: true }));

  const admission = resolveConcurrencyAdmission({
    category: "shared_state",
    declaredLimit: 1,
    sharedStateIdentity: sharedStateDir,
    provider: "kimi",
    route: "subscription",
  });

  assert.equal(admission.limit, 1);
  assert.throws(
    () => resolveConcurrencyAdmission({
      category: "shared_state",
      declaredLimit: 2,
      sharedStateIdentity: sharedStateDir,
      provider: "kimi",
      route: "subscription",
    }),
    /shared_state/,
  );
});

test("stateless concurrency admission uses cap-only env limit", () => {
  const lowered = resolveConcurrencyAdmission({
    category: "stateless",
    declaredLimit: 4,
    limitEnv: "RELAY_TEST_LIMIT",
    provider: "deepseek",
    route: "api",
    env: { RELAY_TEST_LIMIT: "2" },
  });
  assert.equal(lowered.limit, 2);

  const capped = resolveConcurrencyAdmission({
    category: "stateless",
    declaredLimit: 4,
    limitEnv: "RELAY_TEST_LIMIT",
    provider: "deepseek",
    route: "api",
    env: { RELAY_TEST_LIMIT: "99" },
  });
  assert.equal(capped.limit, 4);
});

test("concurrency admission fails closed on malformed category and unresolved shared_state identity", () => {
  assert.throws(
    () => resolveConcurrencyAdmission({ category: "bogus", provider: "x", route: "api" }),
    /category/,
  );
  assert.throws(
    () => resolveConcurrencyAdmission({
      category: "shared_state",
      declaredLimit: 1,
      sharedStateIdentity: null,
      provider: "kimi",
      route: "subscription",
    }),
    /identity/,
  );
  assert.throws(
    () => resolveConcurrencyAdmission({
      category: "shared_state",
      declaredLimit: 1,
      sharedStateIdentity: path.join(tmpdir(), "relay-policy-missing-shared-state"),
      provider: "kimi",
      route: "subscription",
    }),
    /identity/,
  );
});

test("shared_state concurrency admission can key on a stable non-directory identity string", () => {
  const first = resolveConcurrencyAdmission({
    category: "shared_state",
    declaredLimit: 1,
    identityString: "grok-web:endpoint=http://127.0.0.1:3000/v1;admin=sha256:abc",
    provider: "grok-web",
    route: "subscription_web",
  });
  const second = resolveConcurrencyAdmission({
    category: "shared_state",
    declaredLimit: 1,
    identityString: "grok-web:endpoint=http://127.0.0.1:3000/v1;admin=sha256:abc",
    provider: "grok-web",
    route: "subscription_web",
  });
  const different = resolveConcurrencyAdmission({
    category: "shared_state",
    declaredLimit: 1,
    identityString: "grok-web:endpoint=http://127.0.0.1:3001/v1;admin=sha256:abc",
    provider: "grok-web",
    route: "subscription_web",
  });

  assert.equal(first.concurrencyKey, second.concurrencyKey);
  assert.notEqual(first.concurrencyKey, different.concurrencyKey);
  assert.match(first.concurrencyKey, /^[a-f0-9]{64}$/);
  assert.equal(first.limit, 1);
});

test("shared_state concurrency admission ignores lock root override outside test mode", (t) => {
  const sharedStateDir = mkdtempSync(path.join(tmpdir(), "relay-policy-shared-state-"));
  t.after(() => rmSync(sharedStateDir, { recursive: true, force: true }));

  const admission = resolveConcurrencyAdmission({
    category: "shared_state",
    declaredLimit: 1,
    sharedStateIdentity: sharedStateDir,
    provider: "kimi",
    route: "subscription",
    env: {
      XDG_STATE_HOME: path.join(tmpdir(), "relay-policy-state"),
      RELAY_PROVIDER_WORKLOAD_LOCK_DIR: "/decoy",
    },
  });

  assert.ok(!admission.lockRoot.startsWith("/decoy"));
  assert.equal(admission.lockRoot, path.join(tmpdir(), "relay-policy-state", "relay", "locks", "v2"));
});

test("shared_state concurrency admission defaults lock root to tmpdir when XDG_STATE_HOME is absent", (t) => {
  const sharedStateDir = mkdtempSync(path.join(tmpdir(), "relay-policy-shared-state-"));
  t.after(() => rmSync(sharedStateDir, { recursive: true, force: true }));

  const admission = resolveConcurrencyAdmission({
    category: "shared_state",
    declaredLimit: 1,
    sharedStateIdentity: sharedStateDir,
    provider: "kimi",
    route: "subscription",
    env: {},
  });

  assert.equal(admission.lockRoot, path.join(tmpdir(), "relay", "locks", "v2"));
});

test("stateless concurrency admission honors lock root override", () => {
  const admission = resolveConcurrencyAdmission({
    category: "stateless",
    declaredLimit: 4,
    provider: "deepseek",
    route: "api",
    env: { RELAY_PROVIDER_WORKLOAD_LOCK_DIR: "/relay-test-locks" },
  });

  assert.equal(admission.lockRoot, "/relay-test-locks");
});

test("two shared_state concurrency admissions for the same dir produce the same key", (t) => {
  const sharedStateDir = mkdtempSync(path.join(tmpdir(), "relay-policy-shared-state-"));
  t.after(() => rmSync(sharedStateDir, { recursive: true, force: true }));

  const a = resolveConcurrencyAdmission({
    category: "shared_state",
    declaredLimit: 1,
    sharedStateIdentity: sharedStateDir,
    provider: "alias-a",
    route: "subscription",
  });
  const b = resolveConcurrencyAdmission({
    category: "shared_state",
    declaredLimit: 1,
    sharedStateIdentity: sharedStateDir,
    provider: "alias-b",
    route: "subscription",
  });

  assert.equal(a.concurrencyKey, b.concurrencyKey);
  assert.ok(!a.concurrencyKey.startsWith("alias-a."));
  assert.ok(!b.concurrencyKey.startsWith("alias-b."));
});

test("shared_state concurrency admission keys symlink-equivalent paths by directory identity, not path string", (t) => {
  const sharedStateDir = mkdtempSync(path.join(tmpdir(), "relay-policy-shared-state-real-"));
  const linkRoot = mkdtempSync(path.join(tmpdir(), "relay-policy-shared-state-link-root-"));
  const symlinkPath = path.join(linkRoot, "shared-state-link");
  const otherDir = mkdtempSync(path.join(tmpdir(), "relay-policy-shared-state-other-"));
  t.after(() => {
    rmSync(sharedStateDir, { recursive: true, force: true });
    rmSync(linkRoot, { recursive: true, force: true });
    rmSync(otherDir, { recursive: true, force: true });
  });
  symlinkSync(sharedStateDir, symlinkPath, "dir");

  const real = resolveConcurrencyAdmission({
    category: "shared_state",
    declaredLimit: 1,
    sharedStateIdentity: sharedStateDir,
    provider: "alias-real",
    route: "subscription",
  });
  const linked = resolveConcurrencyAdmission({
    category: "shared_state",
    declaredLimit: 1,
    sharedStateIdentity: symlinkPath,
    provider: "alias-link",
    route: "subscription",
  });
  const other = resolveConcurrencyAdmission({
    category: "shared_state",
    declaredLimit: 1,
    sharedStateIdentity: otherDir,
    provider: "alias-other",
    route: "subscription",
  });

  assert.equal(real.concurrencyKey, linked.concurrencyKey);
  assert.notEqual(real.concurrencyKey, other.concurrencyKey);
});

test("kimi source-bearing route facts are derived from mode classification", () => {
  const source = readFileSync(path.join(REPO_ROOT, "plugins/kimi/scripts/kimi-companion.mjs"), "utf8");

  assert.match(
    source,
    /function subscriptionRouteFacts\(\{\s*sourceBearing\s*=\s*false\s*\}\s*=\s*\{\}\)/,
  );
  assert.match(
    source,
    /\.\.\.subscriptionRouteFacts\(\{\s*sourceBearing:\s*modeSendsSelectedSource\(record\.mode\)\s*\}\)/,
  );
  assert.match(
    source,
    /\.\.\.subscriptionRouteFacts\(\{\s*sourceBearing:\s*modeSendsSelectedSource\(mode\)\s*\}\)/,
  );
  assert.match(
    source,
    /\.\.\.subscriptionRouteFacts\(\{\s*sourceBearing:\s*modeSendsSelectedSource\(priorModeName\)\s*\}\)/,
  );
});

// ---------------------------------------------------------------------------
// Task 5 (#234 §7): resend-guard regression — pin HEAD behaviour so a future
// change cannot silently auto-resend a not-sent (admission-blocked) attempt, nor
// over-relax a genuinely-sent post-transmission failure. Drives the public
// evaluateSourcePacketPolicy entrypoint (the composed path), not private helpers.
// The sent-fact must win first: not_sent ⇒ no gate, even when status:"failed".
// ---------------------------------------------------------------------------

const RESEND_GUARD_BASE_INPUT = Object.freeze({
  provider: "kimi",
  mode: "custom-review",
  routeStep: "subscription",
  providerCapabilities: Object.freeze({ subscription: { source_packet: { max_bytes: 64 } } }),
  selectedSource: selectedSourceFixture(8),
  sourceBearing: true,
});

test("admission-blocked retry never requires resend — every PRE_TARGET_NOT_SENT code stays not_sent (§7)", () => {
  // provider_workload_blocked (the #234 admission block) must be in the swept set, or the
  // regression has no teeth — this is the exact code a concurrency block produces.
  assert.ok(
    PRE_TARGET_NOT_SENT_ERROR_CODES.has("provider_workload_blocked"),
    "provider_workload_blocked must be a pre-target not-sent code",
  );
  for (const code of PRE_TARGET_NOT_SENT_ERROR_CODES) {
    const previousAttempt = {
      status: "failed",
      error_code: code,
      source_content_transmission: "not_sent",
      selected_source: selectedSourceFixture(8),
    };
    const result = evaluateSourcePacketPolicy({ ...RESEND_GUARD_BASE_INPUT, previousAttempt });
    // The source was never sent, so the sent-fact gate cannot fire — regardless of error code
    // or status:"failed". A retry of the SAME packet is allowed without confirmation.
    assert.equal(result.resend_confirmation_required, false, `code ${code} must not require resend`);
    assert.notEqual(result.source_packet_action, "resend_confirmation_required", `code ${code} must not gate`);
    assert.equal(result.source_send_allowed, true, `code ${code} must allow the retry to send`);
  }
});

test("a genuinely-sent post-transmission failure STILL requires resend — no over-relaxation (§7)", () => {
  // Representative SOURCE_SEND_BLOCKING_FAILURES (module-private in provider-route-policy.mjs):
  // post-send failures that MUST keep gating after the not_sent relaxation, under both the
  // definitely-sent and ambiguous (may_be_sent) transmission states.
  for (const code of ["timeout", "usage_limited", "review_not_completed", "review_quality_failed", "invalid_verdict", "model_capacity"]) {
    for (const transmission of ["sent", "may_be_sent"]) {
      const previousAttempt = {
        error_code: code,
        source_content_transmission: transmission,
        selected_source: selectedSourceFixture(8),
      };
      const result = evaluateSourcePacketPolicy({ ...RESEND_GUARD_BASE_INPUT, previousAttempt });
      assert.equal(result.resend_confirmation_required, true, `sent ${code}/${transmission} must require resend`);
      assert.equal(result.source_packet_action, "resend_confirmation_required", `sent ${code}/${transmission} must gate`);
      assert.equal(result.source_send_allowed, false, `sent ${code}/${transmission} must block auto-send`);
    }
  }
  // The generic status:"failed" path (any failure) with a sent packet also gates.
  const statusFailed = evaluateSourcePacketPolicy({
    ...RESEND_GUARD_BASE_INPUT,
    previousAttempt: { status: "failed", source_content_transmission: "sent", selected_source: selectedSourceFixture(8) },
  });
  assert.equal(statusFailed.resend_confirmation_required, true);
});

test("record disagreement (source_sent:true + not_sent) gates conservatively, never silently sends (§7)", () => {
  // A record whose explicit source_sent flag contradicts its not_sent transmission must resolve
  // toward "was sent" (gate), never fall through to a plain auto-send.
  const result = evaluateSourcePacketPolicy({
    ...RESEND_GUARD_BASE_INPUT,
    previousAttempt: {
      status: "failed",
      source_sent: true,
      source_content_transmission: "not_sent",
      selected_source: selectedSourceFixture(8),
    },
  });
  assert.equal(result.resend_confirmation_required, true, "disagreement must gate, not silently send");
  assert.equal(result.source_packet_action, "resend_confirmation_required");
  assert.equal(result.source_send_allowed, false);
});

// ---------------------------------------------------------------------------
// Task 7 (#234 D2): DeepSeek/GLM stateless routes admit bounded concurrency at
// the default limit 4; the env cap can only LOWER it, never raise above 4.
// ---------------------------------------------------------------------------

test("DeepSeek and GLM stateless routes admit limit 4; env caps lower but never raise (#234 Task 7)", () => {
  for (const [provider, route, limitEnv] of [
    ["deepseek", "direct_api", "RELAY_DEEPSEEK_CONCURRENCY_LIMIT"],
    ["glm", "direct_api", "RELAY_GLM_CONCURRENCY_LIMIT"],
  ]) {
    const fact = providerRoutePolicy.CONCURRENCY_FACTS[provider][route];
    assert.equal(fact.category, "stateless", `${provider} must stay stateless`);
    assert.equal(fact.limit, 4, `${provider} must default to limit 4`);
    assert.equal(fact.limit_env, limitEnv, `${provider} must keep its env cap name`);

    const args = (env) => ({
      category: fact.category, declaredLimit: fact.limit, limitEnv: fact.limit_env,
      provider, route, env,
    });
    // Default: resolves to 4.
    assert.equal(resolveConcurrencyAdmission(args({})).limit, 4, `${provider} default limit`);
    // Env cap lowers it.
    assert.equal(resolveConcurrencyAdmission(args({ [limitEnv]: "2" })).limit, 2, `${provider} env lowers`);
    // Env cannot raise above the fact limit.
    assert.equal(resolveConcurrencyAdmission(args({ [limitEnv]: "10" })).limit, 4, `${provider} env cannot raise`);
  }
});

test("DeepSeek and GLM stateless routes ignore malformed or zero env caps and keep declared limit 4", () => {
  for (const [provider, route, limitEnv] of [
    ["deepseek", "direct_api", "RELAY_DEEPSEEK_CONCURRENCY_LIMIT"],
    ["glm", "direct_api", "RELAY_GLM_CONCURRENCY_LIMIT"],
  ]) {
    const fact = providerRoutePolicy.CONCURRENCY_FACTS[provider][route];
    for (const badValue of ["0", "-1", "1.5", "abc", ""]) {
      const admission = resolveConcurrencyAdmission({
        category: fact.category,
        declaredLimit: fact.limit,
        limitEnv: fact.limit_env,
        provider,
        route,
        env: { [limitEnv]: badValue },
      });
      assert.equal(admission.limit, 4, `${provider} must ignore malformed env cap ${JSON.stringify(badValue)}`);
    }
  }
});

test("custom direct_api stays single-flight (limit 1) — unknown endpoint capacity (#234 Task 7)", () => {
  const fact = providerRoutePolicy.CONCURRENCY_FACTS.custom.direct_api;
  assert.equal(fact.category, "stateless");
  assert.equal(fact.limit, 1, "custom endpoints stay single-flight until proven");
  assert.equal(
    resolveConcurrencyAdmission({
      category: fact.category, declaredLimit: fact.limit, limitEnv: fact.limit_env,
      provider: "custom", route: "direct_api", env: {},
    }).limit,
    1,
  );
});
