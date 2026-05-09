import { test } from "node:test";
import assert from "node:assert/strict";

import { elapsedMs } from "../../scripts/lib/time.mjs";

test("elapsedMs returns a non-negative millisecond duration", () => {
  assert.equal(
    elapsedMs("2026-05-09T10:00:00.000Z", "2026-05-09T10:00:01.250Z"),
    1250
  );
  assert.equal(
    elapsedMs("2026-05-09T10:00:01.250Z", "2026-05-09T10:00:00.000Z"),
    0
  );
});

test("elapsedMs returns null for invalid timestamps", () => {
  assert.equal(elapsedMs("not a date", "2026-05-09T10:00:00.000Z"), null);
  assert.equal(elapsedMs("2026-05-09T10:00:00.000Z", "not a date"), null);
});
