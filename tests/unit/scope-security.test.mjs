// Cross-provider scope-security coverage. The live-file scope hardening
// (fd-based O_NOFOLLOW copy with a realpath/isInsidePath re-check that closes a
// regular-file-swap TOCTOU, plus a per-file byte cap) was applied as a class fix
// to every provider that ships scope.mjs — agy/claude/gemini/kimi share a
// byte-identical copy. These tests exercise the new paths against EACH copy so a
// future divergence (or a coverage regression on any one provider) fails loudly,
// rather than covering only one provider's copy.
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
const SCOPE_PROVIDERS = ["agy", "claude", "gemini", "kimi"];

function scopeHref(provider) {
  return pathToFileURL(path.join(REPO_ROOT, `plugins/${provider}/scripts/lib/scope.mjs`)).href;
}

function profile(scope) {
  return { name: scope, scope, containment: "worktree" };
}

function cleanup(...paths) {
  for (const p of paths) rmSync(p, { recursive: true, force: true });
}

async function loadFreshScope(provider, label) {
  return import(`${scopeHref(provider)}?${provider}-${label}=${Date.now()}`);
}

for (const provider of SCOPE_PROVIDERS) {
  test(`${provider} populateScope refuses a regular-file swap to an out-of-root symlink`, { skip: process.platform === "win32" }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), `${provider}-scope-toctou-`));
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

      const { populateScope } = await loadFreshScope(provider, "toctou");
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

  test(`${provider} populateScope refuses individual live files above the secure read cap`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), `${provider}-scope-file-cap-`));
    const src = path.join(root, "src");
    const tgt = path.join(root, "tgt");
    try {
      mkdirSync(src, { recursive: true });
      mkdirSync(tgt, { recursive: true });
      const large = path.join(src, "large.bin");
      writeFileSync(large, "");
      truncateSync(large, (8 * 1024 * 1024) + 1);

      const { populateScope } = await loadFreshScope(provider, "file-cap");
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
}
