import { test } from "node:test";
import assert from "node:assert/strict";
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGY_SCOPE = pathToFileURL(path.join(REPO_ROOT, "plugins/agy/scripts/lib/scope.mjs")).href;

function profile(scope) {
  return { name: scope, scope, containment: "worktree" };
}

function cleanup(...paths) {
  for (const p of paths) rmSync(p, { recursive: true, force: true });
}

async function loadFreshAgyScope(label) {
  return import(`${AGY_SCOPE}?${label}=${Date.now()}`);
}

test("AGY populateScope refuses a regular-file swap to an out-of-root symlink", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "agy-scope-toctou-"));
  const src = path.join(root, "src");
  const tgt = path.join(root, "tgt");
  const outside = path.join(root, "outside");
  const victim = path.join(src, "nested", "victim.txt");
  const targetDir = path.join(tgt, "nested");
  const outsideSecret = path.join(outside, "secret.txt");
  const originalMkdir = fs.mkdirSync;
  let swapped = false;
  try {
    mkdirSync(path.dirname(victim), { recursive: true });
    mkdirSync(tgt, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(victim, "safe source\n", "utf8");
    writeFileSync(outsideSecret, "outside workspace secret body\n", "utf8");

    fs.mkdirSync = function patchedMkdir(target, options) {
      const result = originalMkdir.call(this, target, options);
      if (!swapped && path.resolve(String(target)) === path.resolve(targetDir)) {
        swapped = true;
        unlinkSync(victim);
        symlinkSync(outsideSecret, victim);
      }
      return result;
    };
    syncBuiltinESMExports();

    const { populateScope } = await loadFreshAgyScope("toctou");
    assert.throws(
      () => populateScope(profile("custom"), src, tgt, { scopePaths: ["nested/victim.txt"] }),
      /unsafe_symlink|scope_population_failed/,
    );
    assert.equal(existsSync(path.join(tgt, "nested", "victim.txt")), false);
  } finally {
    fs.mkdirSync = originalMkdir;
    syncBuiltinESMExports();
    cleanup(root);
  }
});

test("AGY populateScope refuses individual live files above the secure read cap", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "agy-scope-file-cap-"));
  const src = path.join(root, "src");
  const tgt = path.join(root, "tgt");
  try {
    mkdirSync(src, { recursive: true });
    mkdirSync(tgt, { recursive: true });
    const large = path.join(src, "large.bin");
    writeFileSync(large, "");
    truncateSync(large, (8 * 1024 * 1024) + 1);

    const { populateScope } = await loadFreshAgyScope("file-cap");
    assert.throws(
      () => populateScope(profile("custom"), src, tgt, { scopePaths: ["large.bin"] }),
      /scope_file_too_large/,
    );
    assert.equal(existsSync(path.join(tgt, "large.bin")), false);
    assert.throws(() => readFileSync(path.join(tgt, "large.bin")), /ENOENT/);
  } finally {
    cleanup(root);
  }
});
