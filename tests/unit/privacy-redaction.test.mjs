import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REDACTED_SOURCE_EXCERPT,
  buildPrivacyRedactor,
} from "../../scripts/lib/privacy-redaction.mjs";

test("privacy redactor replaces over-threshold selected-source excerpts and preserves bounded evidence", () => {
  const longExcerpt = `SOURCE_BODY_SENTINEL_${"A".repeat(220)}`;
  const boundedEvidence = `bounded evidence ${"B".repeat(90)}`;
  const sourceText = [
    "header",
    longExcerpt,
    boundedEvidence,
    "footer",
  ].join("\n");
  const redact = buildPrivacyRedactor({
    sourceFiles: [{ path: "seed.txt", text: sourceText }],
  });

  const out = redact.text([
    "Verdict: REQUEST_CHANGES",
    `Blocking finding copied too much source: ${longExcerpt}`,
    `Short quote should survive: ${boundedEvidence}`,
  ].join("\n"));

  assert.match(out, new RegExp(REDACTED_SOURCE_EXCERPT.replaceAll("[", "\\[").replaceAll("]", "\\]")));
  assert.doesNotMatch(out, new RegExp(longExcerpt));
  assert.match(out, new RegExp(boundedEvidence));
});

test("privacy redactor: short cookie attributes do not over-redact benign output (Path=/ regression)", () => {
  // A semicolon cookie env value like "session=...; Path=/" must NOT register the
  // single-char "/" (from the "Path=/" subpart) as a global secret. Before the
  // minLength guard on cookie subparts/values, every benign slash in provider output
  // was redacted (hello/world -> hello[REDACTED]world), corrupting diagnostics.
  const redact = buildPrivacyRedactor({
    env: { APP_COOKIE: "session=YWJjZA==; Domain=example.test; Path=/" },
  });
  assert.equal(redact.text("hello/world"), "hello/world");
  assert.equal(redact.text("path/to/file"), "path/to/file");
  // The over-threshold session secret value is still redacted — the fix narrows
  // over-redaction, it does not weaken real secret coverage.
  assert.doesNotMatch(redact.text("cookie was YWJjZA=="), /YWJjZA==/);
});

test("privacy redactor enforces aggregate selected-source quote budget", () => {
  const snippets = Array.from({ length: 9 }, (_, index) =>
    `quote-${index}-${String.fromCharCode(65 + index).repeat(94)}`
  );
  const sourceText = snippets.map((snippet, index) => `${snippet}\nsource-gap-${index}`).join("\n");
  const redact = buildPrivacyRedactor({
    sourceFiles: [{ path: "seed.txt", text: sourceText }],
  });
  const out = redact.text(snippets.join("\nreview gap\n"));

  assert.match(out, new RegExp(REDACTED_SOURCE_EXCERPT.replaceAll("[", "\\[").replaceAll("]", "\\]")));
  assert.match(out, new RegExp(snippets[0]));
  assert.doesNotMatch(out, new RegExp(snippets.at(-1)));
});

test("privacy redactor enforces aggregate source budget across object fields", () => {
  const snippets = Array.from({ length: 9 }, (_, index) =>
    `field-${index}-${String.fromCharCode(65 + index).repeat(94)}`
  );
  const sourceText = snippets.map((snippet, index) => `${snippet}\nsource-gap-${index}`).join("\n");
  const redact = buildPrivacyRedactor({
    sourceFiles: [{ path: "seed.txt", text: sourceText }],
  });
  const out = redact.value(Object.fromEntries(
    snippets.map((snippet, index) => [`field_${index}`, `Reviewer quote: ${snippet}`])
  ));
  const serialized = JSON.stringify(out);

  assert.match(serialized, new RegExp(REDACTED_SOURCE_EXCERPT.replaceAll("[", "\\[").replaceAll("]", "\\]")));
  assert.match(serialized, new RegExp(snippets[0]));
  assert.doesNotMatch(serialized, new RegExp(snippets.at(-1)));
});

test("privacy redactor preserves object schema keys even when source contains matching identifiers", () => {
  const snippets = Array.from({ length: 9 }, (_, index) =>
    `schema-budget-${index}-${String.fromCharCode(65 + index).repeat(94)}`
  );
  const redact = buildPrivacyRedactor({
    sourceFiles: [{
      path: "schema.js",
      text: [
        "export const REVIEW_FIELDS = ['failed_review_slot', 'suggested_action', 'has_non_blocking_section'];",
        snippets.map((snippet, index) => `${snippet}\nsource-gap-${index}`).join("\n"),
        "export const LONG_SOURCE = 'SOURCE_BODY_SENTINEL_DO_NOT_PERSIST_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';",
      ].join("\n"),
    }],
  });

  const out = redact.value({
    budget_burn: snippets.join("\nreview gap\n"),
    failed_review_slot: false,
    suggested_action: "Quoted source: SOURCE_BODY_SENTINEL_DO_NOT_PERSIST_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    review_quality: {
      has_non_blocking_section: true,
    },
  });

  assert.deepEqual(Object.keys(out), ["budget_burn", "failed_review_slot", "suggested_action", "review_quality"]);
  assert.deepEqual(Object.keys(out.review_quality), ["has_non_blocking_section"]);
  assert.match(out.suggested_action, new RegExp(REDACTED_SOURCE_EXCERPT.replaceAll("[", "\\[").replaceAll("]", "\\]")));
});

test("privacy redactor applies generic credential and account-token patterns", () => {
  const redact = buildPrivacyRedactor({
    env: { CODEX_PLUGIN_PRIVACY_TOKEN: "env-secret-value-12345" },
  });

  const out = redact.text([
    "Authorization: Bearer reflected-token-value",
    "Bearer alternate-token-value",
    "JWT eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.signature",
    "customer cus_NXLKj1H plan_id=pro+stripe-sub-abc/123 user user@example.com",
    "provider echoed env-secret-value-12345",
  ].join("\n"));

  assert.doesNotMatch(out, /reflected-token-value|alternate-token-value|eyJhbGci|cus_NXLKj1H|stripe-sub|user@example\.com|env-secret-value/);
  assert.match(out, /\[REDACTED\]/);
});

test("privacy redactor redacts complete Authorization and Cookie header values", () => {
  const redact = buildPrivacyRedactor();

  const out = redact.text([
    "Authorization: Basic dXNlcjpwYXNz",
    "authorization: ApiKey agy-secret-api-key-12345",
    "Authorization: Digest username=\"alice\", realm=\"example.com\", nonce=\"abc123\"",
    "Cookie: session=super-cookie-secret; theme=dark",
    "Set-Cookie: refresh=super-refresh-secret; HttpOnly",
    "{\"headers\":{\"Authorization\":\"ApiKey json-secret-token-12345\",\"Cookie\":\"session=json-cookie-secret\"}}",
  ].join("\n"));

  assert.doesNotMatch(
    out,
    /dXNlcjpwYXNz|agy-secret-api-key|alice|example\.com|abc123|super-cookie-secret|super-refresh-secret|json-secret-token|json-cookie-secret/,
  );
  assert.match(out, /Authorization: \[REDACTED\]/);
  assert.match(out, /Cookie: \[REDACTED\]/);
  assert.match(out, /Set-Cookie: \[REDACTED\]/);
  assert.match(out, /"Authorization":"\[REDACTED\]"/);
  assert.match(out, /"Cookie":"\[REDACTED\]"/);
});

test("privacy redactor redacts entire Authorization values with spoofed timeout diagnostics", () => {
  const redact = buildPrivacyRedactor();
  const out = redact.text([
    "Authorization: Bearer x; configured_timeout_ms=1 SUPERSECRETVALUE",
    "Authorization: Basic dXNlcjpwYXNz; configured_timeout_ms=5 trailing-secret",
    "Authorization: CustomToken; configured_timeout_ms=7 compact-secret",
  ].join("\n"));

  assert.doesNotMatch(out, /Bearer x|configured_timeout_ms|SUPERSECRETVALUE|dXNlcjpwYXNz|trailing-secret|CustomToken|compact-secret/);
  assert.equal(out, [
    "Authorization: [REDACTED]",
    "Authorization: [REDACTED]",
    "Authorization: [REDACTED]",
  ].join("\n"));
});

test("privacy redactor redacts public-prefix, PEM, and base64 secret shapes", () => {
  const redact = buildPrivacyRedactor();

  const out = redact.text([
    "OPENAI_API_KEY=sk-1234567890abcdefghijklmnop",
    "GITHUB_TOKEN=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "GITHUB_OAUTH=gho_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    "AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP",
    "GOOGLE_API_KEY=AIzaSyA-1234567890abcdefghijk_1234567890ZZ",
    "GITLAB_TOKEN=glpat-abcdefghijklmnopqrstuv",
    // Slack-bot-token shape assembled at runtime so the literal never trips a secret scanner
    // while still exercising the xoxb- redaction pattern with the same value.
    `SLACK_BOT_TOKEN=${["xoxb", "123456789012", "123456789012", "abcdefghijklmnopqrstuvwxyz"].join("-")}`,
    "base64_secret=QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0123456789+/==",
    "-----BEGIN PRIVATE KEY-----",
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
    "-----END PRIVATE KEY-----",
  ].join("\n"));

  assert.doesNotMatch(out, /sk-1234567890|ghp_AAAA|gho_BBBB|AKIAABCDEFGHIJKLMNOP|AIzaSyA-|glpat-abcdef|xoxb-123456|QUJDREVGR0|BEGIN PRIVATE KEY|MIIEvQIB/);
  assert.match(out, /\[REDACTED\]/);
});

test("privacy redactor captures full cookie values containing equals", () => {
  const redact = buildPrivacyRedactor({
    env: { APP_COOKIE: "session=YWJjZA==; Domain=example.test; Path=/" },
  });

  const out = redact.text("provider echoed bare cookie value YWJjZA==");

  assert.equal(out, "provider echoed bare cookie value [REDACTED]");
});

test("privacy redactor preserves non-payment provider tokens while redacting payment-shaped ids", () => {
  const redact = buildPrivacyRedactor();
  const out = redact.text([
    "provider id sub_livealias should remain visible for diagnostics",
    "payment id sub_12345abc should be hidden",
    "authorization fallback Authorization: opaque-token, next",
  ].join("\n"));

  assert.match(out, /sub_livealias/);
  assert.doesNotMatch(out, /sub_12345abc|opaque-token/);
  assert.match(out, /authorization fallback Authorization: \[REDACTED\]$/);
});
