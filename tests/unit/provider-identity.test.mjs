import { test } from "node:test";
import assert from "node:assert/strict";

import { buildProviderAccountIdentity } from "../../scripts/lib/provider-identity.mjs";

test("provider identity helper emits stable pseudonymous account fingerprints", () => {
  const identity = buildProviderAccountIdentity("Claude Code", {
    email: "User@Example.com",
    orgId: "org-secret-123",
    accountId: "acct-secret-456",
  });

  assert.equal(identity.provider, "claude-code");
  assert.equal(identity.identity_source, "provider_auth_status");
  assert.deepEqual(identity.identity_fields, ["account_id", "email", "org_id"]);
  assert.equal(identity.account_fingerprint.algorithm, "sha256");
  assert.match(identity.account_fingerprint.value, /^[a-f0-9]{64}$/);

  const same = buildProviderAccountIdentity("Claude Code", {
    email: "user@example.com",
    org_id: "org-secret-123",
    account_id: "acct-secret-456",
  });
  assert.equal(same.account_fingerprint.value, identity.account_fingerprint.value);

  const serialized = JSON.stringify(identity);
  assert.doesNotMatch(serialized, /User@Example\.com/i);
  assert.doesNotMatch(serialized, /org-secret-123/);
  assert.doesNotMatch(serialized, /acct-secret-456/);
});

test("provider identity helper returns null without account identifiers", () => {
  assert.equal(buildProviderAccountIdentity("Claude Code", {
    loggedIn: true,
    subscriptionType: "max",
  }), null);
});
