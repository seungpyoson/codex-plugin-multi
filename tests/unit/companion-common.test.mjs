import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PING_PROMPT,
  credentialNameDiagnostics,
  preflightDisclosure,
  preflightSafetyFields,
} from "../../scripts/lib/companion-common.mjs";
import { COMPANION_PLUGIN_TARGETS } from "../../scripts/lib/plugin-targets.mjs";

test("companion-common exposes the shared ping prompt", () => {
  assert.equal(
    PING_PROMPT,
    "reply with exactly: pong. Do not use any tools, do not read files, and do not explore the workspace.",
  );
});

test("companion-common builds provider preflight safety fields", () => {
  assert.deepEqual(preflightSafetyFields(), {
    target_spawned: false,
    selected_scope_sent_to_provider: false,
    requires_external_provider_consent: true,
  });
  assert.match(preflightDisclosure("Claude"), /Claude was not spawned/);
  assert.match(preflightDisclosure("Gemini"), /external review still sends/);
});

test("credentialNameDiagnostics reports key names only", () => {
  const result = credentialNameDiagnostics(["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"], {
    ANTHROPIC_API_KEY: "secret-test-value",
    CLAUDE_API_KEY: "",
  });
  assert.deepEqual(result, {
    ignored_env_credentials: ["ANTHROPIC_API_KEY"],
    auth_policy: "api_key_env_ignored",
  });
  assert.doesNotMatch(JSON.stringify(result), /secret-test-value/);
});

test("credentialNameDiagnostics omits fields when no provider key is present", () => {
  assert.deepEqual(credentialNameDiagnostics(["ANTHROPIC_API_KEY"], {}), {});
});

test("plugin packaging copies expose the canonical helper behavior", async () => {
  const modules = await Promise.all(
    COMPANION_PLUGIN_TARGETS.map((plugin) =>
      import(`../../plugins/${plugin}/scripts/lib/companion-common.mjs`)
    )
  );
  for (const mod of modules) {
    assert.equal(mod.PING_PROMPT, PING_PROMPT);
    assert.deepEqual(mod.preflightSafetyFields(), preflightSafetyFields());
    assert.equal(mod.preflightDisclosure("Target"), preflightDisclosure("Target"));
    assert.deepEqual(
      mod.credentialNameDiagnostics(["PROVIDER_API_KEY"], { PROVIDER_API_KEY: "secret-test-value" }),
      credentialNameDiagnostics(["PROVIDER_API_KEY"], { PROVIDER_API_KEY: "secret-test-value" }),
    );
    assert.deepEqual(
      mod.credentialNameDiagnostics(["__CODEX_PLUGIN_MULTI_MISSING_TEST_KEY__"]),
      credentialNameDiagnostics(["__CODEX_PLUGIN_MULTI_MISSING_TEST_KEY__"]),
    );
  }
});

test("external-review plugin copies keep stale no-pid transmission unknown", async () => {
  const modules = await Promise.all(
    COMPANION_PLUGIN_TARGETS.map((plugin) =>
      import(`../../plugins/${plugin}/scripts/lib/external-review.mjs`)
    )
  );
  for (const mod of modules) {
    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "stale",
      errorCode: "stale_active_job",
      pidInfo: null,
    }), mod.SOURCE_CONTENT_TRANSMISSION.UNKNOWN);
  }
});

test("external-review shared helper covers disclosure and transmission branches", async () => {
  const modules = await Promise.all(
    COMPANION_PLUGIN_TARGETS.map((plugin) =>
      import(`../../plugins/${plugin}/scripts/lib/external-review.mjs`)
    )
  );

  for (const mod of modules) {
    const T = mod.SOURCE_CONTENT_TRANSMISSION;
    assert.equal(mod.providerDisplayName("claude"), "Claude Code");
    assert.equal(mod.providerDisplayName("unknown-target"), "unknown-target");
    assert.equal(mod.targetProcessReceivedContent("timeout"), true);
    assert.equal(mod.targetProcessReceivedContent("scope_failed"), false);

    assert.equal(
      mod.externalReviewDisclosure("Provider", "queued", T.MAY_BE_SENT),
      "Selected source content may be sent to Provider for external review.",
    );
    assert.equal(
      mod.externalReviewDisclosure("Provider", "completed", T.SENT),
      "Selected source content was sent to Provider for external review.",
    );
    assert.equal(
      mod.externalReviewDisclosure("Provider", "running", T.SENT),
      "Selected source content was sent to Provider for external review; the run is in progress.",
    );
    assert.equal(
      mod.externalReviewDisclosure("Provider", "cancelled", T.SENT),
      "Selected source content was sent to Provider for external review; the operator cancelled the run before it completed.",
    );
    assert.equal(
      mod.externalReviewDisclosure("Provider", "failed", T.SENT),
      "Selected source content was sent to Provider for external review, but the run ended before a clean result was produced.",
    );
    assert.equal(
      mod.externalReviewDisclosure("Provider", "cancelled", T.NOT_SENT),
      "Selected source content was not sent to Provider; the operator cancelled the run before the target process was started.",
    );
    assert.equal(
      mod.externalReviewDisclosure("Provider", "failed", T.NOT_SENT, "scope_failed"),
      "Selected source content was not sent to Provider; the review scope was rejected before the target process was started.",
    );
    assert.equal(
      mod.externalReviewDisclosure("Provider", "failed", T.NOT_SENT, "spawn_failed"),
      "Selected source content was not sent to Provider; the target process was not spawned.",
    );
    assert.equal(
      mod.externalReviewDisclosure("Provider", "failed", T.NOT_SENT, "unknown_pre_spawn"),
      "Selected source content was not sent to Provider; the target process was not started.",
    );
    assert.equal(
      mod.externalReviewDisclosure("Provider", "stale", T.UNKNOWN),
      "Selected source content may have been sent to Provider; the run became stale before completion.",
    );
    assert.equal(
      mod.externalReviewDisclosure("Provider", "failed", T.UNKNOWN),
      "Selected source content may have been sent to Provider; the run ended before a clean result was produced.",
    );

    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "queued",
      errorCode: null,
      pidInfo: null,
    }), T.MAY_BE_SENT);
    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "running",
      errorCode: null,
      pidInfo: { pid: 1 },
    }), T.SENT);
    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "running",
      errorCode: null,
      pidInfo: null,
    }), T.MAY_BE_SENT);
    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "stale",
      errorCode: "stale_active_job",
      pidInfo: { pid: 1 },
    }), T.SENT);
    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "failed",
      errorCode: "scope_failed",
      pidInfo: null,
    }), T.NOT_SENT);
    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "failed",
      errorCode: "spawn_failed",
      pidInfo: null,
    }), T.NOT_SENT);
    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "cancelled",
      errorCode: null,
      pidInfo: { pid: 1 },
    }), T.SENT);
    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "cancelled",
      errorCode: null,
      pidInfo: null,
    }), T.NOT_SENT);
    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "completed",
      errorCode: null,
      pidInfo: null,
    }), T.SENT);
    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "failed",
      errorCode: "parse_error",
      pidInfo: null,
    }), T.SENT);
    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "failed",
      errorCode: "unknown_target_failure",
      pidInfo: null,
    }), T.UNKNOWN);

    const review = mod.buildExternalReview({
      invocation: {
        target: "kimi",
        run_kind: "background",
        job_id: "job-123",
        parent_job_id: "parent-1",
        mode: "review",
        scope: "custom",
        scope_base: "main",
        scope_paths: ["src/file.mjs"],
      },
      sessionId: "session-1",
      status: "completed",
      sourceContentTransmission: T.SENT,
    });
    assert.equal(review.provider, "Kimi Code CLI");
    assert.equal(review.run_kind, "background");
    assert.equal(review.session_id, "session-1");
    assert.deepEqual(review.scope_paths, ["src/file.mjs"]);
    assert.throws(() => {
      review.marker = "mutated";
    }, TypeError);
  }
});
