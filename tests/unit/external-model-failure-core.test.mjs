import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildExternalModelFailureDiagnostic,
  classifyCompanionErrorMessage,
  classifyCompanionExecution,
  classifyCompanionLifecycleState,
} from "../../scripts/lib/external-model-failure-core.mjs";
import { REVIEW_PROMPT_PLUGIN_TARGETS } from "../../scripts/lib/plugin-targets.mjs";

test("classifyCompanionLifecycleState preserves companion lifecycle states", () => {
  assert.deepEqual(classifyCompanionLifecycleState(null), {
    status: "queued",
    error_code: null,
    error_message: null,
  });
  assert.deepEqual(classifyCompanionLifecycleState({ status: "running" }), {
    status: "running",
    error_code: null,
    error_message: null,
  });
  assert.deepEqual(classifyCompanionLifecycleState({ status: "cancelled", exitCode: 0 }), {
    status: "cancelled",
    error_code: null,
    error_message: null,
  });
  assert.deepEqual(classifyCompanionLifecycleState({ status: "stale", errorMessage: "pid gone" }), {
    status: "stale",
    error_code: "stale_active_job",
    error_message: "pid gone",
  });
});

test("classifyCompanionErrorMessage centralizes shared pre-spawn failures", () => {
  assert.deepEqual(classifyCompanionErrorMessage("not_authed: login missing"), {
    status: "failed",
    error_code: "not_authed",
    error_message: "login missing",
  });
  assert.deepEqual(classifyCompanionErrorMessage("sandbox_blocked: state unreadable"), {
    status: "failed",
    error_code: "sandbox_blocked",
    error_message: "state unreadable",
  });
  assert.deepEqual(classifyCompanionErrorMessage("source_packet_too_large: 524289 > 524288"), {
    status: "failed",
    error_code: "source_packet_too_large",
    error_message: "524289 > 524288",
  });
  assert.deepEqual(classifyCompanionErrorMessage("resend_confirmation_required: retry needs approval"), {
    status: "failed",
    error_code: "resend_confirmation_required",
    error_message: "retry needs approval",
  });
  assert.deepEqual(classifyCompanionErrorMessage("unsafe_symlink:/tmp/source"), {
    status: "failed",
    error_code: "scope_failed",
    error_message: "unsafe_symlink:/tmp/source",
  });
  assert.deepEqual(classifyCompanionErrorMessage("finalization_failed: cannot write meta"), {
    status: "failed",
    error_code: "finalization_failed",
    error_message: "finalization_failed: cannot write meta",
  });
  assert.deepEqual(classifyCompanionErrorMessage("ENOENT target"), {
    status: "failed",
    error_code: "spawn_failed",
    error_message: "ENOENT target",
  });
});

test("classifyCompanionErrorMessage allows provider-specific message overrides", () => {
  const state = classifyCompanionErrorMessage("oauth_inference_rejected: invalid auth", {
    classifyProviderErrorMessage(message) {
      if (!String(message).startsWith("oauth_inference_rejected:")) return null;
      return {
        status: "failed",
        error_code: "oauth_inference_rejected",
        error_message: "invalid auth",
      };
    },
  });

  assert.deepEqual(state, {
    status: "failed",
    error_code: "oauth_inference_rejected",
    error_message: "invalid auth",
  });
});

test("buildExternalModelFailureDiagnostic covers shared emitted failure codes", () => {
  for (const code of [
    "git_binary_rejected",
    "finalization_failed",
    "timeout",
    "spawn_failed",
    "parse_error",
    "provider_error",
    "claude_error",
    "gemini_error",
    "kimi_error",
    "source_packet_too_large",
    "resend_confirmation_required",
  ]) {
    const diagnostic = buildExternalModelFailureDiagnostic(code, "Claude Code CLI");
    assert.equal(typeof diagnostic?.error_summary, "string", code);
    assert.equal(typeof diagnostic?.error_cause, "string", code);
    assert.equal(typeof diagnostic?.suggested_action, "string", code);
    assert.match(diagnostic.error_summary, /Claude Code CLI|provider|scope|review/i, code);
    assert.notEqual(diagnostic.suggested_action.trim(), "", code);
  }
});

test("Claude OAuth inference rejection diagnostic names the supported auth command", () => {
  const diagnostic = buildExternalModelFailureDiagnostic("oauth_inference_rejected", "Claude Code");
  assert.match(diagnostic.suggested_action, /claude auth login/);
  assert.doesNotMatch(diagnostic.suggested_action, /claude login\b/);
  assert.doesNotMatch(diagnostic.suggested_action, /device-auth/);
});

test("shared failure diagnostics cover the T088 cross-provider fixture table", () => {
  const providers = [
    "Claude Code",
    "Gemini CLI",
    "Kimi Code CLI",
    "Grok",
    "DeepSeek",
    "GLM",
  ];
  const codes = [
    "interrupted",
    "timeout",
    "parse_error",
    "step_limit_exceeded",
    "scope_failed",
    "oauth_inference_rejected",
    "usage_limited",
    "provider_unavailable",
    "tunnel_unavailable",
    "session_expired",
    "privacy_persistence",
    "review_not_completed",
    "source_packet_too_large",
    "resend_confirmation_required",
  ];

  for (const provider of providers) {
    for (const code of codes) {
      const diagnostic = buildExternalModelFailureDiagnostic(code, provider);
      assert.ok(diagnostic, `${provider}:${code}`);
      assert.match(diagnostic.error_summary, /Claude|Gemini|Kimi|Grok|DeepSeek|GLM|provider|review|scope/i, `${provider}:${code}`);
      assert.equal(typeof diagnostic.error_cause, "string", `${provider}:${code}`);
      assert.equal(typeof diagnostic.suggested_action, "string", `${provider}:${code}`);
      assert.notEqual(diagnostic.suggested_action.trim(), "", `${provider}:${code}`);
    }
  }
});

test("classifyCompanionExecution centralizes timeout, cancellation, and success semantics", () => {
  assert.deepEqual(
    classifyCompanionExecution(
      {
        exitCode: 143,
        started: true,
        parsed: { ok: false, reason: "empty_stdout", error: "provider closed stdout" },
      },
      { catchallCode: "provider_error" },
    ),
    { status: "failed", error_code: "interrupted", error_message: "provider closed stdout" },
  );
  assert.deepEqual(
    classifyCompanionExecution(
      {
        exitCode: 143,
        started: true,
        parsed: null,
      },
      { catchallCode: "provider_error" },
    ),
    { status: "failed", error_code: "interrupted", error_message: "exit_code:143" },
  );
  assert.deepEqual(classifyCompanionExecution({ timedOut: true }, { catchallCode: "gemini_error" }), {
    status: "failed",
    error_code: "timeout",
    error_message: "target CLI exceeded the configured timeoutMs",
  });
  assert.deepEqual(classifyCompanionExecution({
    exitCode: 1,
    errorMessage: "provider transport closed unexpectedly",
    pidInfo: { pid: 123 },
    parsed: null,
  }, { catchallCode: "provider_error" }), {
    status: "failed",
    error_code: "provider_error",
    error_message: "provider transport closed unexpectedly",
  });
  assert.deepEqual(classifyCompanionExecution({
    exitCode: 1,
    errorMessage: "target binary missing before spawn",
    parsed: null,
  }, { catchallCode: "provider_error" }), {
    status: "failed",
    error_code: "spawn_failed",
    error_message: "target binary missing before spawn",
  });
  assert.deepEqual(classifyCompanionExecution({ signal: "SIGTERM" }, { catchallCode: "gemini_error" }), {
    status: "cancelled",
    error_code: null,
    error_message: null,
  });
  assert.deepEqual(
    classifyCompanionExecution(
      { exitCode: 0, parsed: { ok: true, result: "Verdict: APPROVE" } },
      { catchallCode: "gemini_error" },
    ),
    { status: "completed", error_code: null, error_message: null },
  );
  assert.deepEqual(
    classifyCompanionExecution(
      { exitCode: 1, parsed: { ok: true, result: "Verdict: APPROVE" } },
      { catchallCode: "gemini_error" },
    ),
    { status: "failed", error_code: "gemini_error", error_message: null },
  );
});

test("classifyCompanionExecution centralizes review-quality and common parsed failures", () => {
  assert.deepEqual(
    classifyCompanionExecution(
      {
        exitCode: 0,
        parsed: { ok: true, result: "No verdict" },
        reviewAuditManifest: {
          review_quality: {
            failed_review_slot: true,
            semantic_failure_reasons: ["missing_verdict"],
          },
        },
      },
      { catchallCode: "kimi_error" },
    ),
    {
      status: "failed",
      error_code: "review_not_completed",
      error_message: "review_quality_failed:missing_verdict",
    },
  );
  assert.deepEqual(
    classifyCompanionExecution(
      { exitCode: 1, parsed: { ok: false, reason: "step_limit_exceeded", error: "max steps" } },
      { catchallCode: "kimi_error" },
    ),
    {
      status: "failed",
      error_code: "step_limit_exceeded",
      error_message: "max steps",
    },
  );
});

test("classifyCompanionExecution preserves provider parsed failures and catchall nulls", () => {
  assert.deepEqual(
    classifyCompanionExecution(
      { exitCode: 1, parsed: { ok: false, error: "provider said no" } },
      {
        catchallCode: "claude_error",
        classifyProviderParsedFailure({ parsed }) {
          return {
            status: "failed",
            error_code: "oauth_inference_rejected",
            error_message: parsed.error,
          };
        },
      },
    ),
    {
      status: "failed",
      error_code: "oauth_inference_rejected",
      error_message: "provider said no",
    },
  );
  assert.deepEqual(
    classifyCompanionExecution({ exitCode: 1, parsed: { ok: false } }, { catchallCode: "claude_error" }),
    { status: "failed", error_code: "claude_error", error_message: null },
  );
  assert.deepEqual(
    classifyCompanionExecution({ exitCode: 1 }, { catchallCode: "claude_error" }),
    { status: "failed", error_code: "claude_error", error_message: null },
  );
});

test("external-model failure core plugin copies cover shared classifier branches", async () => {
  const modules = await Promise.all(
    REVIEW_PROMPT_PLUGIN_TARGETS.map((plugin) =>
      import(pathToFileURL(resolve(`plugins/${plugin}/scripts/lib/external-model-failure-core.mjs`)).href)
    )
  );

  for (const mod of modules) {
    assert.deepEqual(mod.classifyCompanionLifecycleState(null), {
      status: "queued",
      error_code: null,
      error_message: null,
    });
    assert.deepEqual(mod.classifyCompanionLifecycleState({ status: "running" }), {
      status: "running",
      error_code: null,
      error_message: null,
    });
    assert.deepEqual(mod.classifyCompanionLifecycleState({ status: "cancelled" }), {
      status: "cancelled",
      error_code: null,
      error_message: null,
    });
    assert.deepEqual(mod.classifyCompanionLifecycleState({ status: "stale" }), {
      status: "stale",
      error_code: "stale_active_job",
      error_message: "stale_active_job",
    });
    assert.equal(mod.classifyCompanionLifecycleState({ status: "completed" }), null);

    assert.deepEqual(mod.classifyCompanionExecution(null, { catchallCode: "provider_error" }), {
      status: "queued",
      error_code: null,
      error_message: null,
    });
    assert.deepEqual(mod.classifyCompanionExecution({ status: "running" }, { catchallCode: "provider_error" }), {
      status: "running",
      error_code: null,
      error_message: null,
    });
    assert.deepEqual(mod.classifyCompanionExecution({ timedOut: true }, { catchallCode: "provider_error" }), {
      status: "failed",
      error_code: "timeout",
      error_message: "target CLI exceeded the configured timeoutMs",
    });
    assert.deepEqual(mod.classifyCompanionExecution({ signal: "SIGINT" }, { catchallCode: "provider_error" }), {
      status: "cancelled",
      error_code: null,
      error_message: null,
    });
    assert.deepEqual(mod.classifySignalLikeExit({
      exitCode: 143,
      started: true,
      parsed: null,
    }), {
      status: "failed",
      error_code: "interrupted",
      error_message: "exit_code:143",
    });
    assert.deepEqual(mod.classifySignalLikeExit({
      exitCode: 143,
      started: true,
      parsed: { ok: true, result: "Verdict: APPROVE" },
      reviewAuditManifest: {
        review_quality: {
          failed_review_slot: true,
          semantic_failure_reasons: ["missing_verdict"],
        },
      },
    }), {
      status: "failed",
      error_code: "review_not_completed",
      error_message: "review_quality_failed:missing_verdict",
    });
    assert.deepEqual(mod.classifyCompanionExecution({
      exitCode: 143,
      started: true,
      parsed: { ok: false, reason: "empty_stdout", error: "interrupted stdout" },
    }, { catchallCode: "provider_error" }), {
      status: "failed",
      error_code: "interrupted",
      error_message: "interrupted stdout",
    });
    assert.deepEqual(mod.classifyCompanionExecution({
      exitCode: 0,
      parsed: { ok: true, structured: { verdict: "APPROVE" } },
    }, { catchallCode: "provider_error" }), {
      status: "completed",
      error_code: null,
      error_message: null,
    });
    assert.deepEqual(mod.classifyCompanionExecution({
      exitCode: 1,
      errorMessage: "not_authed: login required",
      parsed: null,
    }, { catchallCode: "provider_error" }), {
      status: "failed",
      error_code: "not_authed",
      error_message: "login required",
    });
    assert.deepEqual(mod.classifyCompanionExecution({
      exitCode: 1,
      errorMessage: "sandbox_blocked: state unreadable",
      parsed: null,
    }, { catchallCode: "provider_error" }), {
      status: "failed",
      error_code: "sandbox_blocked",
      error_message: "state unreadable",
    });

    assert.deepEqual(mod.classifyCompanionErrorMessage("approval_required: token missing"), {
      status: "failed",
      error_code: "approval_required",
      error_message: "token missing",
    });
    assert.deepEqual(mod.classifyCompanionErrorMessage("source_packet_too_large: 524289 > 524288"), {
      status: "failed",
      error_code: "source_packet_too_large",
      error_message: "524289 > 524288",
    });
    assert.deepEqual(mod.classifyCompanionErrorMessage("resend_confirmation_required: retry needs approval"), {
      status: "failed",
      error_code: "resend_confirmation_required",
      error_message: "retry needs approval",
    });
    assert.deepEqual(mod.classifyCompanionErrorMessage("CODEX_PLUGIN_MULTI_GIT_BINARY rejected"), {
      status: "failed",
      error_code: "git_binary_rejected",
      error_message: "CODEX_PLUGIN_MULTI_GIT_BINARY rejected",
    });
    assert.deepEqual(mod.classifyCompanionErrorMessage("provider override", {
      classifyProviderErrorMessage(message) {
        assert.equal(message, "provider override");
        return {
          status: "failed",
          error_code: "provider_unavailable",
          error_message: "provider override",
        };
      },
    }), {
      status: "failed",
      error_code: "provider_unavailable",
      error_message: "provider override",
    });
    assert.deepEqual(mod.classifyCompanionErrorMessage("scope_empty:no selected files"), {
      status: "failed",
      error_code: "scope_failed",
      error_message: "scope_empty:no selected files",
    });
    assert.deepEqual(mod.classifyCompanionErrorMessage("plain pre-spawn failure"), {
      status: "failed",
      error_code: "spawn_failed",
      error_message: "plain pre-spawn failure",
    });
    assert.deepEqual(mod.classifyCommonParsedFailure({ reason: "usage_limited" }), {
      status: "failed",
      error_code: "usage_limited",
      error_message: "usage_limited",
    });
    assert.deepEqual(mod.classifyCommonParsedFailure({ reason: "step_limit_exceeded", error: "max steps" }), {
      status: "failed",
      error_code: "step_limit_exceeded",
      error_message: "max steps",
    });
    assert.deepEqual(mod.classifyCommonParsedFailure({ reason: "json_parse_error" }), {
      status: "failed",
      error_code: "parse_error",
      error_message: "json_parse_error",
    });
    assert.deepEqual(mod.classifyCommonParsedFailure({ reason: "empty_stdout", error: "no output" }), {
      status: "failed",
      error_code: "parse_error",
      error_message: "no output",
    });
    assert.equal(mod.classifyCommonParsedFailure({ reason: "provider_specific" }), null);
    assert.equal(mod.classifySignalLikeExit(null), null);
    assert.equal(mod.classifySignalLikeExit({ timedOut: true, exitCode: 143 }), null);
    assert.equal(mod.classifySignalLikeExit({ exitCode: 1, started: true }), null);
    assert.equal(mod.classifySignalLikeExit({ exitCode: 143, parsed: null }), null);
    assert.deepEqual(mod.classifySignalLikeExit({
      exitCode: 143,
      started: true,
      parsed: { ok: true, structured: { verdict: "APPROVE" } },
    }), { status: "completed", error_code: null, error_message: null });
    assert.deepEqual(mod.classifySignalLikeExit({
      exitCode: 143,
      phase: "post_spawn",
      parsed: { ok: false, reason: "", result: null, structured: null },
    }), {
      status: "failed",
      error_code: "interrupted",
      error_message: "",
    });
    assert.equal(mod.classifySignalLikeExit({
      exitCode: 143,
      started: true,
      parsed: { ok: false, reason: "provider_error", error: "provider failed" },
    }), null);
    assert.deepEqual(mod.classifyCompanionExecution({
      exitCode: 1,
      parsed: { ok: false, reason: "usage_limited" },
    }, { catchallCode: "provider_error" }), {
      status: "failed",
      error_code: "usage_limited",
      error_message: "usage_limited",
    });
    assert.deepEqual(mod.classifyCompanionExecution({
      exitCode: 1,
      parsed: { ok: false, reason: "provider_specific", error: "provider rejected" },
    }, {
      catchallCode: "provider_error",
      invocation: { target: "test" },
      classifyProviderParsedFailure({ invocation, parsed }) {
        assert.equal(invocation.target, "test");
        return {
          status: "failed",
          error_code: "provider_unavailable",
          error_message: parsed.error,
        };
      },
    }), {
      status: "failed",
      error_code: "provider_unavailable",
      error_message: "provider rejected",
    });
    assert.equal(mod.buildExternalModelFailureDiagnostic("unknown_failure_code", "Provider"), null);
  }
});
