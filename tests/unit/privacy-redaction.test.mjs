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
  assert.match(out, /Authorization: \[REDACTED\], next/);
});
