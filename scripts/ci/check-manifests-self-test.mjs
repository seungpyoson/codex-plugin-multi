#!/usr/bin/env node
// Self-test for check-manifests.mjs. Creates temp broken fixtures and asserts
// the linter exits non-zero with the expected error text. Exits 0 on success.

import { mkdtemp, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LINTER = resolve(REPO_ROOT, "scripts/ci/check-manifests.mjs");

let failed = 0;

async function fixture(name, setup) {
  const dir = await mkdtemp(join(tmpdir(), `check-manifests-st-${name}-`));
  try {
    // Start from a copy of the real repo, then mutate.
    for (const f of [
      ".agents/plugins/marketplace.json",
      "plugins/claude/.codex-plugin/plugin.json",
      "plugins/gemini/.codex-plugin/plugin.json",
      "plugins/claude/commands/claude-review.md",
      "plugins/gemini/commands/gemini-review.md",
      "plugins/claude/skills/claude-cli-runtime/SKILL.md",
      "plugins/claude/skills/claude-delegation/SKILL.md",
      "plugins/claude/agents/claude-rescue.md",
    ]) {
      await mkdir(dirname(join(dir, f)), { recursive: true });
      await cp(resolve(REPO_ROOT, f), join(dir, f));
    }
    // Copy linter script to a discoverable relative path.
    await mkdir(join(dir, "scripts/ci"), { recursive: true });
    await cp(LINTER, join(dir, "scripts/ci/check-manifests.mjs"));
    await setup(dir);
    const res = spawnSync("node", ["scripts/ci/check-manifests.mjs"], {
      cwd: dir,
      encoding: "utf8",
    });
    return { dir, ...res };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function expectFail(name, setup, matchText) {
  const res = await fixture(name, setup);
  const combined = (res.stdout || "") + (res.stderr || "");
  if (res.status === 0) {
    process.stderr.write(`✗ [${name}] expected lint to FAIL but it passed\n`);
    failed++;
    return;
  }
  if (matchText && !combined.includes(matchText)) {
    process.stderr.write(`✗ [${name}] expected error to contain "${matchText}"; got:\n${combined}\n`);
    failed++;
    return;
  }
  process.stdout.write(`✓ [${name}] linter rejected the broken fixture\n`);
}

// Case 1: authentication: "NEVER" (invalid — Codex rejects).
await expectFail(
  "auth-never",
  async (dir) => {
    const p = join(dir, ".agents/plugins/marketplace.json");
    const m = JSON.parse(await (await import("node:fs/promises")).readFile(p, "utf8"));
    m.plugins[0].policy.authentication = "NEVER";
    await writeFile(p, JSON.stringify(m, null, 2));
  },
  `authentication`
);

// Case 2: plugin name with colon (violates bare-name rule).
await expectFail(
  "colon-name",
  async (dir) => {
    const p = join(dir, "plugins/claude/.codex-plugin/plugin.json");
    const m = JSON.parse(await (await import("node:fs/promises")).readFile(p, "utf8"));
    m.name = "claude:target";
    await writeFile(p, JSON.stringify(m, null, 2));
  },
  `lowercase + hyphens`
);

// Case 3: command with unknown frontmatter key.
await expectFail(
  "unknown-frontmatter",
  async (dir) => {
    const p = join(dir, "plugins/claude/commands/claude-review.md");
    await writeFile(
      p,
      `---\ndescription: ok\ndisable-model-invocation: true\n---\nBody\n`
    );
  },
  `unknown frontmatter key`
);

// Case 4: command filename with colon.
await expectFail(
  "colon-filename",
  async (dir) => {
    const src = join(dir, "plugins/claude/commands/claude-review.md");
    const dst = join(dir, "plugins/claude/commands/claude:review.md");
    await cp(src, dst);
    await rm(src);
  },
  `filename stem`
);

// Case 5: unknown capability value.
await expectFail(
  "bad-capability",
  async (dir) => {
    const p = join(dir, "plugins/claude/.codex-plugin/plugin.json");
    const m = JSON.parse(await (await import("node:fs/promises")).readFile(p, "utf8"));
    m.interface.capabilities = ["Interactive", "SuperUser"];
    await writeFile(p, JSON.stringify(m, null, 2));
  },
  `capabilities`
);

// Case 6: non-semver version.
await expectFail(
  "non-semver",
  async (dir) => {
    const p = join(dir, "plugins/claude/.codex-plugin/plugin.json");
    const m = JSON.parse(await (await import("node:fs/promises")).readFile(p, "utf8"));
    m.version = "v1";
    await writeFile(p, JSON.stringify(m, null, 2));
  },
  `semver`
);

// Case 7: skill with unknown frontmatter key.
await expectFail(
  "skill-unknown-frontmatter",
  async (dir) => {
    const p = join(dir, "plugins/claude/skills/claude-cli-runtime/SKILL.md");
    await writeFile(
      p,
      `---\nname: claude-cli-runtime\ndescription: ok\nuser-invocable: false\nextra-key: nope\n---\nBody\n`
    );
  },
  `unknown frontmatter key`
);

// Case 8: agent with unknown frontmatter key.
await expectFail(
  "agent-unknown-frontmatter",
  async (dir) => {
    const p = join(dir, "plugins/claude/agents/claude-rescue.md");
    await writeFile(
      p,
      `---\nname: claude-rescue\ndescription: ok\nmodel: inherit\ntools: Bash\nskills:\n  - claude-cli-runtime\nextra-key: nope\n---\nBody\n`
    );
  },
  `unknown frontmatter key`
);

// Case 9: plugin with user-invocable skills must expose the skills root.
await expectFail(
  "missing-skills-pointer",
  async (dir) => {
    const p = join(dir, "plugins/claude/.codex-plugin/plugin.json");
    const m = JSON.parse(await (await import("node:fs/promises")).readFile(p, "utf8"));
    delete m.skills;
    await writeFile(p, JSON.stringify(m, null, 2));
  },
  `skills`
);

// Case 10: commands manifest field must stay forbidden until upstream Codex
// supports plugin command-file registration and dispatch.
await expectFail(
  "commands-manifest-field",
  async (dir) => {
    const p = join(dir, "plugins/claude/.codex-plugin/plugin.json");
    const m = JSON.parse(await (await import("node:fs/promises")).readFile(p, "utf8"));
    m.commands = "./commands";
    await writeFile(p, JSON.stringify(m, null, 2));
  },
  `commands`
);

if (failed > 0) {
  process.stderr.write(`\n${failed} self-test case(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\n✓ all self-test cases passed\n");
