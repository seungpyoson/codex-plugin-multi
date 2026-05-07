// tests/unit/smoke-rerecord-wiring.test.mjs
//
// Wiring tests — empirical proof for two contracts that round-10 closed
// by code change but never observed end-to-end:
//
//   C5 (preflight reads spec.env, not process.env): preflightCheck must
//       consult the env attached to the recipe's spec, not whatever
//       process.env happens to look like at preflight time. Otherwise a
//       recipe that mutates env in spawnArgs (e.g. claude/auth-failure
//       scrubs auth) gets validated against a different environment
//       than recordResponse will spawn with.
//
//   C10 (main() entry guard handles symlinked argv1): the round-10 fix
//       wraps argv[1] in path.resolve + realpathSync so npm/npx shim
//       invocations (where argv[1] is a symlink, not the source file)
//       still match import.meta.url. Without these tests, the change
//       was a structural-only edit with no observation.

import { strict as assert } from "node:assert";
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isEntryScript, preflightCheck } from "../../scripts/smoke-rerecord.mjs";

// On macOS, os.tmpdir() can return "/var/folders/.../T" which is a
// symlink to "/private/var/folders/.../T". The runtime guard inside
// isEntryScript calls realpathSync, so callers comparing against
// pathToFileURL(rawPath) would mismatch. Resolve up-front so synthetic
// argv1 / scriptUrl pairs stay aligned with what the predicate sees.
const RESOLVED_TMP = realpathSync(tmpdir());

// ───────────────────────────────────────────────────────────────────────
// preflightCheck wiring (C5)
// ───────────────────────────────────────────────────────────────────────

function withStubbedProcessExit(fn) {
  const originalExit = process.exit;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let exitCode = null;
  process.exit = (code) => {
    exitCode = code ?? 0;
    throw new Error("PROCESS_EXIT_STUB");
  };
  process.stderr.write = () => true; // swallow diagnostic output
  try {
    fn();
    return { exited: false, code: null };
  } catch (e) {
    if (e?.message === "PROCESS_EXIT_STUB") {
      return { exited: true, code: exitCode };
    }
    throw e;
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderrWrite;
  }
}

describe("preflightCheck — wiring (C5)", () => {
  it("requireEnvAny: passes when spec.env has the key (process.env does NOT)", () => {
    // Wipe process.env so we can prove preflight is reading from spec.env.
    const KEY = "PFK_ENVAREONLY";
    delete process.env[KEY];
    const result = withStubbedProcessExit(() => {
      preflightCheck({
        env: { [KEY]: "from-spec-env" },
        requireEnvAny: [KEY],
      });
    });
    assert.equal(result.exited, false,
      "preflightCheck must accept spec.env as the source of auth state");
  });

  it("requireEnvAny: fails when process.env has the key but spec.env does NOT", () => {
    // Counter-direction: if preflight were reading process.env, this
    // would falsely pass. Setting the key in process.env but not in
    // spec.env catches that bug.
    const KEY = "PFK_PROCONLY";
    process.env[KEY] = "live-process-env";
    try {
      const result = withStubbedProcessExit(() => {
        preflightCheck({
          env: {},
          requireEnvAny: [KEY],
        });
      });
      assert.equal(result.exited, true,
        "preflightCheck must NOT fall through to process.env when spec.env lacks the key");
      assert.equal(result.code, 2);
    } finally {
      delete process.env[KEY];
    }
  });

  it("requireEnvOrFile: passes when spec.env has the key and process.env does NOT", () => {
    const KEY = "PFK_OF_ENVONLY";
    delete process.env[KEY];
    const result = withStubbedProcessExit(() => {
      preflightCheck({
        env: { [KEY]: "from-spec-env" },
        requireEnvOrFile: { envAny: [KEY], file: "/var/empty/.nonexistent" },
      });
    });
    assert.equal(result.exited, false);
  });

  it("requireEnvOrFile: fails when process.env has the key but spec.env does NOT", () => {
    const KEY = "PFK_OF_PROCONLY";
    process.env[KEY] = "live-process-env";
    try {
      const result = withStubbedProcessExit(() => {
        preflightCheck({
          env: {},
          requireEnvOrFile: { envAny: [KEY], file: "/var/empty/.nonexistent" },
        });
      });
      assert.equal(result.exited, true);
      assert.equal(result.code, 2);
    } finally {
      delete process.env[KEY];
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// isEntryScript wiring (C10)
// ───────────────────────────────────────────────────────────────────────

describe("isEntryScript — wiring (C10)", () => {
  it("returns false when argv1 is undefined", () => {
    assert.equal(isEntryScript("file:///x/y.mjs", undefined), false);
  });

  it("returns false when argv1 is empty string", () => {
    assert.equal(isEntryScript("file:///x/y.mjs", ""), false);
  });

  it("returns true when argv1 resolves to the script URL (direct invocation)", () => {
    const tmp = mkdtempSync(path.join(RESOLVED_TMP, "smoke-rerecord-direct-"));
    const scriptPath = path.join(tmp, "smoke-rerecord.mjs");
    writeFileSync(scriptPath, "// stub");
    const scriptUrl = pathToFileURL(scriptPath).href;
    assert.equal(isEntryScript(scriptUrl, scriptPath), true);
  });

  it("returns false when argv1 is a different path", () => {
    const tmp = mkdtempSync(path.join(RESOLVED_TMP, "smoke-rerecord-mismatch-"));
    const scriptPath = path.join(tmp, "smoke-rerecord.mjs");
    const otherPath = path.join(tmp, "other.mjs");
    writeFileSync(scriptPath, "// stub");
    writeFileSync(otherPath, "// stub");
    const scriptUrl = pathToFileURL(scriptPath).href;
    assert.equal(isEntryScript(scriptUrl, otherPath), false);
  });

  it("resolves a symlinked argv1 (npm/npx shim case) — empirical proof of round-10 fix", () => {
    // This is the actual behavioral test for C10. argv[1] is the
    // symlink (the npm/npx shim); the script's import.meta.url is the
    // real underlying path. Without realpathSync, these don't match
    // and main() never runs.
    const tmp = mkdtempSync(path.join(RESOLVED_TMP, "smoke-rerecord-symlink-"));
    const realScript = path.join(tmp, "smoke-rerecord.mjs");
    const shim = path.join(tmp, "shim");
    writeFileSync(realScript, "// stub");
    symlinkSync(realScript, shim);

    const scriptUrl = pathToFileURL(realScript).href;
    assert.equal(
      isEntryScript(scriptUrl, shim),
      true,
      "isEntryScript must resolve symlinked argv1 to match the underlying script's URL",
    );
  });

  it("resolves a relative argv1 (node scripts/x.mjs from repo root)", () => {
    // Node passes argv[1] as the user wrote it. If they wrote a
    // relative path, isEntryScript must resolve it against cwd before
    // comparing to the absolute import.meta.url.
    const tmp = mkdtempSync(path.join(RESOLVED_TMP, "smoke-rerecord-rel-"));
    const scriptPath = path.join(tmp, "smoke-rerecord.mjs");
    writeFileSync(scriptPath, "// stub");
    const scriptUrl = pathToFileURL(scriptPath).href;

    const originalCwd = process.cwd();
    process.chdir(tmp);
    try {
      assert.equal(isEntryScript(scriptUrl, "./smoke-rerecord.mjs"), true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("uses the same predicate as the runtime guard (regression seal)", () => {
    // Sanity: what import.meta.url + process.argv[1] would resolve to
    // if smoke-rerecord were imported as a module (which it is, in
    // this very test file) — should NOT report as entry script.
    const smokeRerecordUrl = pathToFileURL(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "scripts",
        "smoke-rerecord.mjs",
      ),
    ).href;
    // process.argv[1] here is the test runner, not smoke-rerecord.
    assert.equal(isEntryScript(smokeRerecordUrl, process.argv[1]), false);
  });
});
