import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REDACTED_SOURCE_EXCERPT,
  buildPrivacyRedactor as buildSharedPrivacyRedactor,
} from "../../scripts/lib/privacy-redaction.mjs";
import { buildPrivacyRedactor as buildApiPrivacyRedactor } from "../../plugins/api-reviewers/scripts/lib/privacy-redaction.mjs";
import { buildPrivacyRedactor as buildClaudePrivacyRedactor } from "../../plugins/claude/scripts/lib/privacy-redaction.mjs";
import { buildPrivacyRedactor as buildGeminiPrivacyRedactor } from "../../plugins/gemini/scripts/lib/privacy-redaction.mjs";
import { buildPrivacyRedactor as buildGrokPrivacyRedactor } from "../../plugins/grok/scripts/lib/privacy-redaction.mjs";
import { buildPrivacyRedactor as buildKimiPrivacyRedactor } from "../../plugins/kimi/scripts/lib/privacy-redaction.mjs";

const PROVIDERS = Object.freeze([
  ["shared", buildSharedPrivacyRedactor],
  ["api-reviewers", buildApiPrivacyRedactor],
  ["claude", buildClaudePrivacyRedactor],
  ["gemini", buildGeminiPrivacyRedactor],
  ["grok", buildGrokPrivacyRedactor],
  ["kimi", buildKimiPrivacyRedactor],
]);

test("cross-provider privacy redactors enforce the same source and secret persistence policy", () => {
  const snippets = Array.from({ length: 9 }, (_, index) =>
    `provider-field-${index}-${String.fromCharCode(65 + index).repeat(86)}`
  );
  const longSourceBody = `SOURCE_BODY_SENTINEL_DO_NOT_PERSIST_${"Z".repeat(230)}`;
  const sourceText = [longSourceBody, ...snippets].join("\nsource-gap\n");

  for (const [provider, buildPrivacyRedactor] of PROVIDERS) {
    const redact = buildPrivacyRedactor({
      env: {
        [`${provider.toUpperCase().replaceAll("-", "_")}_API_KEY`]: "secret-test-value-12345",
        CUSTOM_REVIEW_TOKEN: "abcd",
      },
      configuredSecretNames: ["CUSTOM_REVIEW_TOKEN"],
      sourceFiles: [{ path: "seed.txt", text: sourceText }],
    });
    const out = redact.value({
      result: `provider echoed secret-test-value-12345 and ${longSourceBody}`,
      error_message: "Authorization: Bearer short-token",
      structured_output: Object.fromEntries(
        snippets.map((snippet, index) => [`field_${index}`, `quoted ${snippet}`])
      ),
      configured: "custom value abcd",
    });
    const serialized = JSON.stringify(out);

    assert.match(serialized, new RegExp(REDACTED_SOURCE_EXCERPT.replaceAll("[", "\\[").replaceAll("]", "\\]")), provider);
    assert.doesNotMatch(serialized, /SOURCE_BODY_SENTINEL_DO_NOT_PERSIST|secret-test-value|short-token|abcd/, provider);
    assert.doesNotMatch(serialized, new RegExp(snippets.at(-1)), provider);
  }
});
