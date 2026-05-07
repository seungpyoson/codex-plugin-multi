import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isUsageLimitDetail,
  usageLimitMessage,
  usageLimitMessageWithMaxLength,
} from "../../scripts/lib/usage-limit.mjs";

test("usage-limit helper detects durable quota and billing markers", () => {
  for (const detail of [
    "insufficient_quota",
    "payment_required",
    "usage limit reached for this billing cycle",
    "billing_account hard limit exceeded",
    "credit limit exceeded",
    "insufficient credits",
    "Error code: 403\nYou've reached your usage limit.",
  ]) {
    assert.equal(isUsageLimitDetail(detail), true, detail);
    assert.equal(usageLimitMessage(detail)?.includes(detail.split("\n")[0]), true, detail);
  }
});

test("usage-limit helper does not classify transient rate or capacity wording", () => {
  for (const detail of [
    "Rate limit exceeded for requests per minute. Retry later.",
    "MODEL_CAPACITY_EXHAUSTED: No capacity available; model is capacity-limited.",
    "Provider rate limit overloaded this shard.",
  ]) {
    assert.equal(isUsageLimitDetail(detail), false, detail);
    assert.equal(usageLimitMessage(detail), null, detail);
  }
});

test("usage-limit helper keeps caller-specific truncation bounds", () => {
  const message = `usage limit ${"x".repeat(20)}`;
  assert.equal(usageLimitMessageWithMaxLength(12, message), "usage limit ...");
});
