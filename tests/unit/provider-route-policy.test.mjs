import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeApprovalScope,
  selectProviderRoute,
} from "../../scripts/lib/provider-route-policy.mjs";

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
    auth_path: "subscription_oauth",
    billing_path: null,
    fallback_reason: null,
    allowed_env_credentials: [],
    ignored_env_credentials: ["PROVIDER_API_KEY"],
    source_send_approval_required: false,
    source_send_approval_state: "not_required",
  });
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
    selected_route: "direct_api",
    auth_path: "api_key_env",
    billing_path: { endpoint: "https://api-only.example.invalid", model: "review-model" },
    fallback_reason: "subscription_not_supported",
    allowed_env_credentials: ["API_ONLY_KEY"],
    ignored_env_credentials: [],
    source_send_approval_required: true,
    source_send_approval_state: "required",
  });
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
    selected_route: "direct_api",
    auth_path: "api_key_env",
    billing_path: { endpoint: "https://api.example.invalid", model: "review-model" },
    fallback_reason: "usage_limited",
    allowed_env_credentials: ["PROVIDER_API_KEY"],
    ignored_env_credentials: [],
    source_send_approval_required: true,
    source_send_approval_state: "approved",
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
    /route mode must be subscription or api; got "auto"/,
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

test("kimi source-bearing route facts are derived from review mode", () => {
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
