// tests/unit/smoke-rerecord-preflight.test.mjs
//
// Covers the contract of `checkAuthOrFile`, the helper used by
// `preflightCheck` in scripts/smoke-rerecord.mjs to validate auth
// prerequisites for recipes whose recipe-side auth can come from EITHER
// a wired API-key env var OR an on-disk CLI auth directory.
//
// Greptile P1 #3199437297 reported that the file-only check rejected
// fresh CI runners (no ~/.claude) even when the workflow had wired the
// secret. These tests pin the corrected semantics: env-or-file, with
// either branch sufficient and empty-string env values treated as
// unset.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { checkAuthOrFile } from "../../scripts/lib/smoke-rerecord-preflight.mjs";

describe("checkAuthOrFile", () => {
  it("ok when an envAny key has a non-empty value (env branch)", () => {
    const r = checkAuthOrFile(
      { envAny: ["FOO_KEY", "BAR_KEY"], file: "/missing/path" },
      {
        env: { BAR_KEY: "live-secret" },
        fileExists: () => false,
      },
    );
    assert.equal(r.ok, true);
    assert.equal(r.source, "env");
    assert.equal(r.key, "BAR_KEY");
  });

  it("ok when file exists even if envAny is empty/unset (file branch)", () => {
    const r = checkAuthOrFile(
      { envAny: ["FOO_KEY"], file: "/exists" },
      {
        env: {},
        fileExists: (p) => p === "/exists",
      },
    );
    assert.equal(r.ok, true);
    assert.equal(r.source, "file");
    assert.equal(r.file, "/exists");
  });

  it("env-branch wins over file-branch when both are present", () => {
    // Stable preference matters for diagnostics: a CI runner with both
    // a wired secret and a stray ~/.claude (e.g. left over from a
    // previous job) should report the env source so the operator
    // knows the secret was the satisfier.
    const r = checkAuthOrFile(
      { envAny: ["FOO_KEY"], file: "/exists" },
      {
        env: { FOO_KEY: "value" },
        fileExists: () => true,
      },
    );
    assert.equal(r.ok, true);
    assert.equal(r.source, "env");
  });

  it("fails when both env keys are unset and file is missing", () => {
    const r = checkAuthOrFile(
      { envAny: ["FOO_KEY", "BAR_KEY"], file: "/missing" },
      {
        env: {},
        fileExists: () => false,
      },
    );
    assert.equal(r.ok, false);
    assert.match(r.reason, /no auth available/);
    assert.match(r.reason, /FOO_KEY \/ BAR_KEY/);
    assert.match(r.reason, /\/missing/);
  });

  it("treats empty-string env values as unset", () => {
    // A CI runner where the secret reference is unset typically still
    // exports the variable as "" via `${{ secrets.X }}`. Accepting
    // empty strings as auth would silently pass preflight and then
    // fail downstream with an opaque provider error.
    const r = checkAuthOrFile(
      { envAny: ["FOO_KEY"], file: "/missing" },
      {
        env: { FOO_KEY: "" },
        fileExists: () => false,
      },
    );
    assert.equal(r.ok, false);
    assert.match(r.reason, /FOO_KEY/);
  });

  it("works when only envAny is configured (no file)", () => {
    const r = checkAuthOrFile(
      { envAny: ["FOO_KEY"] },
      {
        env: { FOO_KEY: "v" },
        fileExists: () => false,
      },
    );
    assert.equal(r.ok, true);
    assert.equal(r.source, "env");
  });

  it("works when only file is configured (no envAny)", () => {
    const r = checkAuthOrFile(
      { file: "/exists" },
      {
        env: {},
        fileExists: (p) => p === "/exists",
      },
    );
    assert.equal(r.ok, true);
    assert.equal(r.source, "file");
  });

  it("fails with a clear reason when neither envAny nor file is configured", () => {
    const r = checkAuthOrFile({}, { env: {}, fileExists: () => false });
    assert.equal(r.ok, false);
    assert.match(r.reason, /no env keys configured/);
    assert.match(r.reason, /no file path configured/);
  });
});
