import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateSeededReviewPacket,
} from "../../scripts/lib/review-quality-evaluator.mjs";

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
