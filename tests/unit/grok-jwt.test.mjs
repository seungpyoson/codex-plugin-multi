import { test } from "node:test";
import assert from "node:assert/strict";

import { isJwtShapedToken } from "../../plugins/grok/scripts/lib/jwt.mjs";

test("isJwtShapedToken accepts only three base64url-like JWT segments", () => {
  assert.equal(isJwtShapedToken("abc.def.ghi"), true);
  assert.equal(isJwtShapedToken("abc_def.def-ghi.ghi123"), true);
  assert.equal(isJwtShapedToken("abc.def"), false);
  assert.equal(isJwtShapedToken("not a token"), false);
  assert.equal(isJwtShapedToken(null), false);
});
