// Shared JobRecord shape assertion used by smoke replay tests across the
// three architectures (companion, grok, api-reviewers). Two-axis check:
//
//   1. Subset (forward-compat): every key in `expectedKeys` must be present
//      on `replayed`. Catches regressions that drop a JobRecord field.
//      Strict key-set equality was rejected because it forced a re-record
//      of every fixture for any benign additive schema change.
//
//   2. Internal-field guard: any *extra* key on `replayed` (one not in
//      `expectedKeys`) must not match suspicious internal-state patterns.
//      Catches regressions where the wrapper accidentally serializes an
//      internal helper's state to the top level (e.g. `_credentials`,
//      `debug_info`, `internal_cache`). The strict-equality check would
//      have caught this; the bare subset check would not.
//
// Net: legitimate additive fields (e.g. `next_review_due`) pass; accidental
// internal-state exposure fails.

import assert from "node:assert/strict";

const SUSPICIOUS_INTERNAL_KEY = /^(?:_|debug_|internal_|private_|secret_|credential)/i;

export function assertJobRecordShape(replayed, expectedKeys, { label } = {}) {
  const tag = label ? `${label}: ` : "";
  for (const key of expectedKeys) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(replayed, key),
      `${tag}replayed JobRecord must include expected key: ${key}`,
    );
  }
  for (const key of Object.keys(replayed)) {
    if (expectedKeys.includes(key)) continue;
    assert.ok(
      !SUSPICIOUS_INTERNAL_KEY.test(key),
      `${tag}replayed JobRecord exposed suspicious internal-state key: ${key}`,
    );
  }
}
