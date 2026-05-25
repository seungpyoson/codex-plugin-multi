import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeApprovalScope,
  buildProviderPolicyContract,
  evaluateSourcePacketPolicy,
  PROVIDER_POLICY_DOMAINS,
  PROVIDER_ROUTE_STEPS,
  selectProviderRoute,
  sourcePacketCanResumeWithoutResendFromJobRecord,
  sourcePacketCanResumeWithoutResendFromPreviousAttempt,
  sourcePacketPreviousAttemptForContinuation,
  sourcePacketPreviousAttemptFromJobRecord,
} from "../../scripts/lib/provider-route-policy.mjs";
import { REVIEW_PROMPT_PLUGIN_TARGETS } from "../../scripts/lib/plugin-targets.mjs";
import { buildReviewAuditManifest } from "../../scripts/lib/review-prompt.mjs";

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
  "audit",
  "docs",
  "sync",
];

const REVIEW_MODES = ["review", "adversarial-review", "custom-review", "rescue"];

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
    status: "failed",
    error_code: "review_not_completed",
    external_review: { source_content_transmission: "sent" },
    review_metadata: {
      audit_manifest: {
        selected_source: selectedSourceFixture(8),
      },
    },
  });

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
