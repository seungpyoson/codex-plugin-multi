import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isUsageLimitDetail,
  usageLimitMessage,
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
    assert.match(usageLimitMessage(detail), /quota|usage-tier|billing|credit/i);
  }
});

test("usage-limit helper does not classify transient rate or capacity wording", () => {
  for (const detail of [
    "Rate limit exceeded for requests per minute. Retry later.",
    "MODEL_CAPACITY_EXHAUSTED: No capacity available; model is capacity-limited.",
    "Provider rate limit overloaded this shard.",
    "Error code: 403\nAuthentication failed.",
    "Error code: 4030",
    "Error code: 40300",
  ]) {
    assert.equal(isUsageLimitDetail(detail), false, detail);
    assert.equal(usageLimitMessage(detail), null, detail);
  }
});

test("usage-limit helper returns stable safe summary", () => {
  const message = `usage limit ${"x".repeat(20)}`;
  assert.match(usageLimitMessage(message), /quota|usage-tier|billing|credit/i);
});

test("usage-limit helper does not return account or payment artifacts", () => {
  const message = usageLimitMessage(
    "usage limit reached for billing account user@example.com plan_id=pro+stripe-sub-abc/123"
  );
  assert.match(message, /quota|usage-tier|billing|credit/i);
  assert.doesNotMatch(message, /user@example\.com|stripe-sub|plan_id/i);
});
