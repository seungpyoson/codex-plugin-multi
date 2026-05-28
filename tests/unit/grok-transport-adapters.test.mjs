import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canAutoFallbackFromCliExecution,
  cliRequestDiagnosticsForFallback,
  promptBudgetEnvName,
  resolveGrokConfig,
  resolveGrokFallbackConfig,
  resolveGrokTransportMode,
  webAutoFallbackConfig,
} from "../../plugins/grok/scripts/lib/grok-transport-adapters.mjs";

test("resolveGrokConfig defaults to subscription CLI adapter facts", () => {
  const cfg = resolveGrokConfig({}, {});

  assert.equal(cfg.transport, "cli");
  assert.equal(cfg.requested_transport, "cli");
  assert.equal(cfg.provider, "grok");
  assert.equal(cfg.display_name, "Grok CLI");
  assert.equal(cfg.auth_mode, "subscription_cli");
  assert.equal(cfg.selected_route, "subscription_cli");
  assert.equal(cfg.prompt_budget_env, "GROK_CLI_MAX_PROMPT_CHARS");
  assert.equal(cfg.default_model_env, "GROK_CLI_MODEL");
  assert.equal(cfg.timeout_env, "GROK_CLI_TIMEOUT_MS");
  assert.equal(cfg.legacy, false);
  assert.equal(cfg.model, "grok-build");
  assert.equal(cfg.timeout_ms, 900000);
  assert.equal(cfg.max_prompt_chars, 400000);
  assert.equal(cfg.max_turns, 8);
  assert.equal(cfg.credential_ref, null);
  assert.equal(cfg.credential_value, null);
  assert.equal(promptBudgetEnvName(cfg), "GROK_CLI_MAX_PROMPT_CHARS");
});

test("canAutoFallbackFromCliExecution requires source-free eligible CLI failure", () => {
  const autoCli = resolveGrokConfig({ transport: "auto" }, {});
  const eligible = {
    exitCode: 1,
    parsed: { reason: "grok_cli_login_required" },
    source_sent: false,
    payload_sent: false,
  };

  assert.equal(canAutoFallbackFromCliExecution(autoCli, eligible), true);
  assert.equal(canAutoFallbackFromCliExecution(resolveGrokConfig({ transport: "cli" }, {}), eligible), false);
  assert.equal(canAutoFallbackFromCliExecution(autoCli, { ...eligible, exitCode: 0 }), false);
  assert.equal(canAutoFallbackFromCliExecution(autoCli, { ...eligible, parsed: { reason: "grok_cli_failed" } }), false);

  for (const sentValue of [true, "sent", "may_be_sent"]) {
    assert.equal(canAutoFallbackFromCliExecution(autoCli, { ...eligible, source_sent: sentValue }), false);
    assert.equal(canAutoFallbackFromCliExecution(autoCli, { ...eligible, payload_sent: sentValue }), false);
  }
});

test("fallback helpers expose web fallback config and redacted CLI diagnostics", () => {
  const fallback = webAutoFallbackConfig({}, {
    GROK_WEB_BASE_URL: "http://127.0.0.1:9999/v1",
  }, "grok_cli_login_required");

  assert.equal(fallback.transport, "web");
  assert.equal(fallback.requested_transport, "auto");
  assert.equal(fallback.fallback_from, "cli");
  assert.equal(fallback.fallback_reason, "grok_cli_login_required");
  assert.equal(fallback.selected_route, "subscription_web");

  const earlyError = resolveGrokFallbackConfig({ transport: "web" }, {});
  assert.equal(earlyError.transport, "web");
  assert.equal(earlyError.requested_transport, "web");
  assert.equal(earlyError.timeout_ms, 900000);

  const diagnostics = cliRequestDiagnosticsForFallback({
    parsed: { reason: "grok_cli_auth_unavailable" },
    diagnostics: {
      model: "grok-build",
      grok_version: "grok 0.1.220",
      default_model: "grok-build",
      logged_in: false,
      model_ready: true,
      exit_status: 1,
      stderr_head: "redacted stderr",
      prompt: "must not leak",
      credential_value: "must not leak",
      grok_home_source: "/tmp/grok-cli-auth-home-123",
      grok_home_copied_files: ["config.json"],
      grok_home_linked_files: ["oauth.json"],
    },
  });

  assert.deepEqual(diagnostics, {
    transport: "cli",
    error_code: "grok_cli_auth_unavailable",
    model: "grok-build",
    grok_version: "grok 0.1.220",
    default_model: "grok-build",
    logged_in: false,
    model_ready: true,
    exit_status: 1,
    exit_signal: null,
    stderr_head: "redacted stderr",
    parse_mode: null,
    source_free_parse_mode: null,
    source_free_prompt_cleanup: null,
    source_free_grok_home_cleanup: null,
    prompt_chars: null,
    configured_timeout_ms: null,
    max_turns: null,
    prompt_cleanup: null,
    neutral_cwd: null,
    neutral_cwd_cleanup: null,
    grok_home_source: "/tmp/grok-cli-auth-home-123",
    grok_home_copied_files: ["config.json"],
    grok_home_linked_files: ["oauth.json"],
    grok_home_cleanup: null,
  });
});

test("resolveGrokFallbackConfig uses safe web defaults for early error records", () => {
  const fallback = resolveGrokFallbackConfig({ transport: "web" }, {
    GROK_WEB_TIMEOUT_MS: "not-a-number",
    GROK_WEB_DOCTOR_TIMEOUT_MS: "not-a-number",
    GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS: "not-a-number",
    GROK_WEB_TUNNEL_START_TIMEOUT_MS: "not-a-number",
    GROK_WEB_TUNNEL_CLEANUP_TIMEOUT_MS: "not-a-number",
    GROK_WEB_MAX_PROMPT_CHARS: "not-a-number",
  });

  assert.equal(fallback.transport, "web");
  assert.equal(fallback.requested_transport, "web");
  assert.equal(fallback.timeout_ms, 900000);
  assert.equal(fallback.doctor_timeout_ms, 2000);
  assert.equal(fallback.chat_doctor_timeout_ms, 10000);
  assert.equal(fallback.tunnel_start_timeout_ms, 8000);
  assert.equal(fallback.tunnel_cleanup_timeout_ms, 2000);
  assert.equal(fallback.max_prompt_chars, 400000);
});

test("resolveGrokConfig exposes web adapter facts and legacy aliases", () => {
  const web = resolveGrokConfig({ transport: "web" }, {
    GROK_WEB_BASE_URL: "http://127.0.0.1:7654/api/v1/",
    GROK2API_BASE_URL: "http://127.0.0.1:8765/api",
    GROK_WEB_MODEL: "grok-web-model",
    GROK_WEB_TIMEOUT_MS: "1234",
    GROK_WEB_MAX_PROMPT_CHARS: "5678",
    GROK_WEB_TUNNEL_API_KEY: "tunnel-token",
  });

  assert.equal(web.transport, "web");
  assert.equal(web.requested_transport, "web");
  assert.equal(web.provider, "grok-web");
  assert.equal(web.auth_mode, "subscription_web");
  assert.equal(web.selected_route, "subscription_web");
  assert.equal(web.base_url, "http://127.0.0.1:7654/api/v1");
  assert.equal(web.grok2api_base_url, "http://127.0.0.1:8765");
  assert.equal(web.model, "grok-web-model");
  assert.equal(web.timeout_ms, 1234);
  assert.equal(web.max_prompt_chars, 5678);
  assert.equal(web.prompt_budget_env, "GROK_WEB_MAX_PROMPT_CHARS");
  assert.equal(web.default_model_env, "GROK_WEB_MODEL");
  assert.equal(web.timeout_env, "GROK_WEB_TIMEOUT_MS");
  assert.equal(web.legacy, false);
  assert.equal(web.credential_ref, "GROK_WEB_TUNNEL_API_KEY");
  assert.equal(web.credential_value, "tunnel-token");
  assert.equal(promptBudgetEnvName(web), "GROK_WEB_MAX_PROMPT_CHARS");

  const legacy = resolveGrokConfig({ transport: "grok-web" }, {});
  assert.equal(legacy.transport, "web");
  assert.equal(legacy.requested_transport, "web");
  assert.equal(legacy.legacy, true);
});

test("resolveGrokConfig treats auto as CLI-primary and rejects unknown transports", () => {
  assert.equal(resolveGrokTransportMode({ transport: "auto" }, {}), "auto");

  const auto = resolveGrokConfig({ transport: "auto" }, {});
  assert.equal(auto.transport, "cli");
  assert.equal(auto.requested_transport, "auto");
  assert.equal(auto.selected_route, "subscription_cli");
  assert.equal(auto.prompt_budget_env, "GROK_CLI_MAX_PROMPT_CHARS");

  assert.throws(
    () => resolveGrokTransportMode({ transport: "satellite" }, {}),
    /bad_args: unsupported Grok transport "satellite"; use cli, web, or auto/,
  );
});

test("direct API credentials do not influence subscription transport config", () => {
  const env = {
    GROK_API_KEY: "paid-grok-api-key",
    XAI_API_KEY: "paid-xai-api-key",
    XAI_KEY: "paid-xai-key",
  };

  const cli = resolveGrokConfig({}, env);
  assert.equal(cli.transport, "cli");
  assert.equal(cli.auth_mode, "subscription_cli");
  assert.equal(cli.credential_ref, null);
  assert.equal(cli.credential_value, null);

  const web = resolveGrokConfig({ transport: "web" }, env);
  assert.equal(web.transport, "web");
  assert.equal(web.auth_mode, "subscription_web");
  assert.equal(web.credential_ref, null);
  assert.equal(web.credential_value, null);

  const auto = resolveGrokConfig({ transport: "auto" }, env);
  assert.equal(auto.transport, "cli");
  assert.equal(auto.auth_mode, "subscription_cli");
  assert.equal(auto.credential_ref, null);
  assert.equal(auto.credential_value, null);

  const fallback = webAutoFallbackConfig({}, env, "grok_cli_login_required");
  assert.equal(fallback.transport, "web");
  assert.equal(fallback.auth_mode, "subscription_web");
  assert.equal(fallback.credential_ref, null);
  assert.equal(fallback.credential_value, null);
});
