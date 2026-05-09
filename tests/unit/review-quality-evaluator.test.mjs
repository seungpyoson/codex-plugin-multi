import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

import {
  evaluateSeededReviewPacket,
} from "../../scripts/lib/review-quality-evaluator.mjs";
import {
  AB_REVIEW_PACKETS,
  COMMON_AB_REVIEW_PROMPT,
  MANUAL_RELAY_JUDGE_CONTEXT,
  buildManualRelayPacketPrompt,
} from "../../scripts/lib/review-quality-ab-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..", "..");

test("seeded evaluator source does not keep unused local helper functions", () => {
  const source = readFileSync(resolvePath(HERE, "..", "..", "scripts/lib/review-quality-evaluator.mjs"), "utf8");

  assert.doesNotMatch(source, /function hasPattern\b/);
});

test("A/B fixture preserves the exact review packets, common prompt, expected findings, and timing contract", () => {
  assert.deepEqual(AB_REVIEW_PACKETS.map((packet) => packet.id), [
    "packet1_correctness",
    "packet2_security",
    "packet3_clean",
  ]);
  assert.match(AB_REVIEW_PACKETS[0].files[0].source, /sum - item\.price/);
  assert.match(AB_REVIEW_PACKETS[0].files[0].source, /user\.plan = "pro"/);
  assert.match(AB_REVIEW_PACKETS[1].files[0].source, /codeMayConstructGateConfig/);
  assert.match(AB_REVIEW_PACKETS[1].expected_findings[0], /gate-config.*before.*approvable/i);
  assert.match(AB_REVIEW_PACKETS[2].expected_result, /No blocking findings/i);
  assert.match(COMMON_AB_REVIEW_PROMPT, /Do not invent findings/i);
  assert.match(COMMON_AB_REVIEW_PROMPT, /State explicitly if you could not inspect/i);
  assert.match(COMMON_AB_REVIEW_PROMPT, /elapsed wall time/i);
  assert.match(MANUAL_RELAY_JUDGE_CONTEXT, /Expected seeded findings/i);
  assert.match(MANUAL_RELAY_JUDGE_CONTEXT, /packet2_security/);
});

test("manual relay packet prompt uses the same common review contract without leaking judge-only answers", () => {
  const prompt = buildManualRelayPacketPrompt("packet2_security");

  assert.match(prompt, /Adversarially review the selected files/);
  assert.match(prompt, /File: packet2_security\/gate\.js/);
  assert.match(prompt, /function shouldDeny/);
  assert.doesNotMatch(prompt, /Expected seeded findings/);
  assert.doesNotMatch(prompt, /gate-config.*before.*approvable/i);
});

test("A/B fixture CLI prints packet prompts and judge context separately", () => {
  const packetPrompt = execFileSync(process.execPath, ["scripts/review-quality-ab-fixture.mjs", "--packet", "packet2_security"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.match(packetPrompt, /File: packet2_security\/gate\.js/);
  assert.match(packetPrompt, /elapsed wall time/);
  assert.doesNotMatch(packetPrompt, /Expected seeded findings/);

  const judgeContext = execFileSync(process.execPath, ["scripts/review-quality-ab-fixture.mjs", "--judge-context"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.match(judgeContext, /Expected seeded findings/);
  assert.match(judgeContext, /packet3_clean/);
});

test("seeded evaluator parses packet3 blocking section without a lazy dot-star regex", () => {
  const source = readFileSync(resolvePath(HERE, "..", "..", "scripts/lib/review-quality-evaluator.mjs"), "utf8");

  assert.doesNotMatch(source, /\[\\s\\S\]\*\?/);
  assert.doesNotMatch(source, /\(\?:\^\|\\n\)\\s\*\(\?:\[-\*\]\|\\d\+\[\.\)\]\)\\s\+\\S/);
});

test("seeded evaluator scans packet3 blocking bullets in linear time", () => {
  const longCleanBody = `${"a".repeat(200_000)}\n3. Non-blocking concerns\n- none`;
  const start = performance.now();
  const result = evaluateSeededReviewPacket({
    packet: "packet3_clean",
    output: `1. Verdict: APPROVE\n2. Blocking findings\n${longCleanBody}`,
  });

  assert.equal(result.false_positive, false);
  assert.ok(performance.now() - start < 250);
});

test("seeded evaluator rejects adjacent packet2 security findings that miss ordering bypass", () => {
  const output = `
1. Verdict: REQUEST CHANGES
2. Blocking findings
- consumeProtectedDirApproval uses predictable /tmp/approval markers derived from the command hash.
- codeMayConstructGateConfig only decodes chr(...) and misses base64 or string concatenation.
3. Non-blocking concerns
- hasWriteIntent is narrow.
`;

  const result = evaluateSeededReviewPacket({
    packet: "packet2_security",
    output,
  });

  assert.equal(result.expected_findings[0].id, "gate_config_ordering_bypass");
  assert.equal(result.expected_findings[0].found, false);
  assert.equal(result.expected_findings_found, false);
  assert.deepEqual(result.missing_expected_findings, ["gate_config_ordering_bypass"]);
});

test("seeded evaluator accepts packet2 only when the gate-config ordering bypass is explicit", () => {
  const output = `
1. Verdict: REQUEST CHANGES
2. Blocking findings
- shouldDeny checks broadProtectedAgentDirWrite first and returns from that branch with approvable: true.
  A command that also triggers codeMayConstructGateConfig / gate-config.json never reaches the later
  approvable: false denial. The gate-config construction check must run before the protected-dir approval path.
`;

  const result = evaluateSeededReviewPacket({
    packet: "packet2_security",
    output,
  });

  assert.equal(result.expected_findings_found, true);
  assert.deepEqual(result.missing_expected_findings, []);
});

test("seeded evaluator distinguishes packet3 clean false positives from non-blocking concerns", () => {
  const cleanConcern = evaluateSeededReviewPacket({
    packet: "packet3_clean",
    output: `
1. Verdict: APPROVE
2. Blocking findings
None.
3. Non-blocking concerns
- canReadDocument assumes user.roles is an array; worth documenting as caller contract.
`,
  });
  assert.equal(cleanConcern.false_positive, false);
  assert.equal(cleanConcern.expected_findings_found, true);

  const falsePositive = evaluateSeededReviewPacket({
    packet: "packet3_clean",
    output: `
1. Verdict: REQUEST CHANGES
2. Blocking findings
- safe.js total() should reject non-array input and NaN prices before reducing.
`,
  });
  assert.equal(falsePositive.false_positive, true);
  assert.equal(falsePositive.expected_findings_found, false);
});

test("seeded evaluator accepts common clean-packet no-blocker phrasing", () => {
  const cleanSynonyms = [
    "- No significant issues.",
    "- No actual problems found.",
    "- No real concerns identified.",
    "- Nothing blocking.",
    "- No real issues identified.",
  ];

  for (const blockingLine of cleanSynonyms) {
    const result = evaluateSeededReviewPacket({
      packet: "packet3_clean",
      output: `
1. Verdict: APPROVE
2. Blocking findings
${blockingLine}
3. Non-blocking concerns
- canReadDocument assumes user.roles is an array; worth documenting as caller contract.
`,
    });

    assert.equal(result.false_positive, false, blockingLine);
    assert.equal(result.expected_findings_found, true, blockingLine);
  }
});

test("seeded evaluator stops packet3 blocking scan at common non-blocking heading variants", () => {
  const result = evaluateSeededReviewPacket({
    packet: "packet3_clean",
    output: `
## Verdict
APPROVE
## Blocking findings
No actual blockers found.
## Suggestions
- Document that canReadDocument expects user.roles to be an array.
`,
  });

  assert.equal(result.false_positive, false);
  assert.equal(result.expected_findings_found, true);
});

test("seeded evaluator detects clean-packet false positives under Markdown headings", () => {
  const result = evaluateSeededReviewPacket({
    packet: "packet3_clean",
    output: `
## Verdict
APPROVE
## Blocking findings
- safe.js should reject non-array input before reducing.
## Non-blocking concerns
- none
`,
  });

  assert.equal(result.false_positive, true);
  assert.equal(result.expected_findings_found, false);
});

test("seeded evaluator requires both packet1 correctness blockers", () => {
  const partial = evaluateSeededReviewPacket({
    packet: "packet1_correctness",
    output: `
1. Verdict: REQUEST CHANGES
2. Blocking findings
- total uses sum - item.price, so prices are subtracted rather than added.
`,
  });

  assert.equal(partial.expected_findings_found, false);
  assert.deepEqual(partial.missing_expected_findings, ["has_discount_assignment"]);

  const complete = evaluateSeededReviewPacket({
    packet: "packet1_correctness",
    output: `
1. Verdict: REQUEST CHANGES
2. Blocking findings
- total uses sum - item.price instead of adding item.price.
- hasDiscount uses user.plan = "pro" assignment instead of === comparison.
`,
  });

  assert.equal(complete.expected_findings_found, true);
  assert.deepEqual(complete.missing_expected_findings, []);
});
