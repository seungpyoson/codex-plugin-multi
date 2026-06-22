// Cross-provider scope-security coverage. The live-file scope hardening
// (fd-based O_NOFOLLOW copy with a realpath/isInsidePath re-check that closes a
// regular-file-swap TOCTOU, plus a per-file byte cap) was applied as a class fix
// to every provider that ships scope.mjs — agy/claude/gemini/kimi share a
// byte-identical copy. These tests exercise the new copy paths AND their error
// branches against EACH copy, so a future divergence (or a coverage regression on
// any one provider) fails loudly rather than covering only one provider's copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs, {
  chmodSync,
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
const POSIX_ONLY = { skip: process.platform === "win32" };

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

// Swap a just-inspected regular file the moment its destination directory is
// created (after copyLiveFile's lstat, before copyLiveRegularFile's realpath/open),
// so the scope copier observes a different inode than it validated.
function onTargetDirCreated(targetDir, action) {
  const originalMkdir = fs.mkdirSync;
  let fired = false;
  fs.mkdirSync = function patchedMkdir(target, options) {
    const result = originalMkdir.call(this, target, options);
    if (!fired && path.resolve(String(target)) === path.resolve(targetDir)) {
      fired = true;
      action();
    }
    return result;
  };
  syncBuiltinESMExports();
  return () => {
    fs.mkdirSync = originalMkdir;
    syncBuiltinESMExports();
  };
}

for (const provider of SCOPE_PROVIDERS) {
  test(`${provider} populateScope refuses a regular-file swap to an out-of-root symlink`, POSIX_ONLY, async () => {
    const root = mkdtempSync(path.join(tmpdir(), `${provider}-scope-toctou-`));
    const src = path.join(root, "src");
    const tgt = path.join(root, "tgt");
    const outside = path.join(root, "outside");
    const victim = path.join(src, "nested", "victim.txt");
    const outsideSecret = path.join(outside, "secret.txt");
    let restore = () => {};
    try {
      mkdirSync(path.dirname(victim), { recursive: true });
      mkdirSync(tgt, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(victim, "safe source\n", "utf8");
      writeFileSync(outsideSecret, "outside workspace secret body\n", "utf8");

      restore = onTargetDirCreated(path.join(tgt, "nested"), () => {
        unlinkSync(victim);
        symlinkSync(outsideSecret, victim);
      });

      const { populateScope } = await loadFreshScope(provider, "toctou");
      assert.throws(
        () => populateScope(profile("custom"), src, tgt, { scopePaths: ["nested/victim.txt"] }),
        /unsafe_symlink|scope_population_failed/,
      );
      assert.equal(existsSync(path.join(tgt, "nested", "victim.txt")), false);
    } finally {
      restore();
      cleanup(root);
    }
  });

  test(`${provider} populateScope refuses a regular-file swap to an in-root symlink (O_NOFOLLOW)`, POSIX_ONLY, async () => {
    const root = mkdtempSync(path.join(tmpdir(), `${provider}-scope-eloop-`));
    const src = path.join(root, "src");
    const tgt = path.join(root, "tgt");
    const victim = path.join(src, "nested", "victim.txt");
    const inRoot = path.join(src, "nested", "sibling.txt");
    let restore = () => {};
    try {
      mkdirSync(path.dirname(victim), { recursive: true });
      mkdirSync(tgt, { recursive: true });
      writeFileSync(victim, "safe source\n", "utf8");
      writeFileSync(inRoot, "in-root body\n", "utf8");

      // Symlink target resolves INSIDE the source root, so realpath/isInsidePath
      // pass; only the O_NOFOLLOW open catches that src became a symlink.
      restore = onTargetDirCreated(path.join(tgt, "nested"), () => {
        unlinkSync(victim);
        symlinkSync(inRoot, victim);
      });

      const { populateScope } = await loadFreshScope(provider, "eloop");
      assert.throws(
        () => populateScope(profile("custom"), src, tgt, { scopePaths: ["nested/victim.txt"] }),
        /unsafe_symlink|scope_population_failed/,
      );
      assert.equal(existsSync(path.join(tgt, "nested", "victim.txt")), false);
    } finally {
      restore();
      cleanup(root);
    }
  });

  test(`${provider} populateScope fails closed when the destination cannot be written`, POSIX_ONLY, async () => {
    const root = mkdtempSync(path.join(tmpdir(), `${provider}-scope-copyfail-`));
    const src = path.join(root, "src");
    const tgt = path.join(root, "tgt");
    const victim = path.join(src, "nested", "victim.txt");
    const targetDir = path.join(tgt, "nested");
    let restore = () => {};
    try {
      mkdirSync(path.dirname(victim), { recursive: true });
      mkdirSync(tgt, { recursive: true });
      writeFileSync(victim, "safe source\n", "utf8");

      // Make the destination dir unwritable right after it is created, so the
      // fd-based copy's tmp-file creation fails and the run terminates closed.
      restore = onTargetDirCreated(targetDir, () => chmodSync(targetDir, 0o500));

      const { populateScope } = await loadFreshScope(provider, "copyfail");
      assert.throws(
        () => populateScope(profile("custom"), src, tgt, { scopePaths: ["nested/victim.txt"] }),
        /scope_population_failed|cannot copy/,
      );
    } finally {
      restore();
      try { chmodSync(targetDir, 0o700); } catch { /* best effort */ }
      cleanup(root);
    }
  });

  test(`${provider} populateScope skips a regular file that races away before copy`, POSIX_ONLY, async () => {
    const root = mkdtempSync(path.join(tmpdir(), `${provider}-scope-enoent-`));
    const src = path.join(root, "src");
    const tgt = path.join(root, "tgt");
    const racer = path.join(src, "vanish", "racer.txt"); // own dir → its mkdir is unique to it
    const keeper = path.join(src, "stays", "keeper.txt");
    let restore = () => {};
    try {
      mkdirSync(path.dirname(racer), { recursive: true });
      mkdirSync(path.dirname(keeper), { recursive: true });
      mkdirSync(tgt, { recursive: true });
      writeFileSync(racer, "raced\n", "utf8");
      writeFileSync(keeper, "kept\n", "utf8");

      // Delete the racer after lstat but before realpath → ENOENT skip (return).
      restore = onTargetDirCreated(path.join(tgt, "vanish"), () => unlinkSync(racer));

      const { populateScope } = await loadFreshScope(provider, "enoent");
      // The raced-away file is skipped silently; the surviving file still copies.
      populateScope(profile("custom"), src, tgt, {
        scopePaths: ["vanish/racer.txt", "stays/keeper.txt"],
      });
      assert.equal(existsSync(path.join(tgt, "vanish", "racer.txt")), false);
      assert.equal(existsSync(path.join(tgt, "stays", "keeper.txt")), true);
    } finally {
      restore();
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
