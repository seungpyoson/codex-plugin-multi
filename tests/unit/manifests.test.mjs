import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DESCRIPTION_MAX_LENGTH = 88;
const DELEGATION_PLUGINS = ["claude", "gemini", "kimi"];
const API_REVIEWER_PROVIDERS = ["deepseek", "glm"];

function readJson(relPath) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relPath), "utf8"));
}

function assertPickerDescription(skill, rel) {
  const description = skill.match(/^description:\s*(.+)$/m)?.[1] ?? "";
  assert.ok(description.length > 0, `${rel} missing description`);
  assert.ok(
    description.length <= DESCRIPTION_MAX_LENGTH,
    `${rel} description too long for picker: ${description.length}`,
  );
}

function assertNoBracketedCliFlagsInBash(skill, rel) {
  for (const [, block] of skill.matchAll(/```bash\n([\s\S]*?)```/g)) {
    assert.doesNotMatch(block, /\[[^\]\n]*--[a-z0-9-]+[^\]\n]*\]/i, `${rel} has bracketed optional CLI syntax`);
  }
}

function assertCompanionWorkflowInvocation(skill, plugin, workflow, rel) {
  assertNoBracketedCliFlagsInBash(skill, rel);
  if (workflow === "setup") {
    assert.match(skill, new RegExp(`${plugin}-companion\\.mjs"\\s+doctor\\b`), `${rel} missing doctor subcommand`);
    return;
  }

  if (["status", "result", "cancel"].includes(workflow)) {
    assert.match(skill, new RegExp(`${plugin}-companion\\.mjs"\\s+${workflow}\\b`), `${rel} missing ${workflow} subcommand`);
    return;
  }

  assert.match(skill, new RegExp(`${plugin}-companion\\.mjs"\\s+run\\b`), `${rel} missing run subcommand`);
  assert.match(skill, new RegExp(`--mode=${workflow}\\b`), `${rel} missing --mode=${workflow}`);
  if (workflow === "rescue") {
    assert.match(skill, /--background\b/, `${rel} missing --background`);
    if (plugin === "kimi") {
      assert.match(skill, /--max-steps-per-turn N/, `${rel} missing Kimi max-step option`);
      assert.match(skill, /`N` must be a positive integer/, `${rel} must define Kimi max-step value`);
    } else {
      assert.doesNotMatch(skill, /--max-steps-per-turn\b/, `${rel} must not document Kimi-only max-step option`);
    }
  } else {
    assert.match(skill, /--foreground\b/, `${rel} missing --foreground`);
  }
  if (["review", "adversarial-review"].includes(workflow)) {
    assert.match(skill, /--scope-base REF/, `${rel} missing optional --scope-base`);
    assert.match(skill, /`<focus>` is the user's review prompt or focus area/, `${rel} must define focus placeholder`);
    assert.match(skill, /external_review|claude-result-handling/, `${rel} missing external review rendering guidance`);
    if (plugin === "kimi") {
      assert.match(skill, /--max-steps-per-turn N/, `${rel} missing Kimi max-step option`);
      assert.match(skill, /`N` must be a positive integer/, `${rel} must define Kimi max-step value`);
    } else {
      assert.doesNotMatch(skill, /--max-steps-per-turn\b/, `${rel} must not document Kimi-only max-step option`);
    }
  }
}

function assertApiReviewerWorkflowInvocation(skill, provider, workflow, rel) {
  assertNoBracketedCliFlagsInBash(skill, rel);
  assert.match(skill, new RegExp(`api-reviewer\\.mjs\\s+${workflow === "setup" ? "doctor" : "run"}\\b`), `${rel} missing api-reviewer subcommand`);
  assert.match(skill, new RegExp(`--provider\\s+${provider}\\b`), `${rel} missing --provider ${provider}`);
  if (workflow === "setup") return;

  assert.match(skill, new RegExp(`--mode\\s+${workflow}\\b`), `${rel} missing --mode ${workflow}`);
  assert.doesNotMatch(skill, /--foreground\b/, `${rel} must not document ignored --foreground flag`);
  assert.match(skill, /--prompt\s+"<focus>"/, `${rel} missing prompt placeholder`);
  assert.match(skill, /`<focus>` is the user's review prompt or focus area/, `${rel} must define focus placeholder`);
  if (workflow === "custom-review") {
    assert.match(skill, /--scope\s+custom\b/, `${rel} missing custom scope`);
    assert.match(skill, /--scope-paths\b/, `${rel} missing --scope-paths`);
    const scopePaths = skill.match(/--scope-paths\s+"([^"]+)"/)?.[1] ?? "";
    assert.ok(scopePaths.includes(","), `${rel} missing comma-separated scope-path placeholder`);
    assert.doesNotMatch(scopePaths, /[*?]/, `${rel} must not use glob characters in scope-path placeholder`);
    assert.doesNotMatch(scopePaths, /\s/, `${rel} scope-path placeholder must not use space-separated paths`);
    assert.match(skill, /Replace `<file1>,<file2>`/, `${rel} must tell agents to replace scope-path placeholders`);
    assert.match(skill, /comma- or newline-separated concrete relative `--scope-paths`/, `${rel} missing scope-path separator guidance`);
    assert.match(skill, /expand globs before running/i, `${rel} missing glob expansion guidance`);
    assert.match(skill, /external_review.*before the review result/, `${rel} missing external_review rendering guidance`);
  } else {
    assert.match(skill, /--scope\s+branch-diff\b/, `${rel} missing branch-diff scope`);
    assert.match(skill, /--scope-base REF/, `${rel} missing optional --scope-base`);
    assert.match(skill, /external_review.*before the review result/, `${rel} missing external_review rendering guidance`);
  }
}

function assertApiReviewerCommandDoc(command, workflow, rel) {
  assert.doesNotMatch(command, /--foreground\b/, `${rel} must not document ignored --foreground flag`);
  if (workflow !== "setup") {
    assert.match(command, /external_review.*before the review result/, `${rel} missing external_review rendering guidance`);
  }
  if (["review", "adversarial-review"].includes(workflow)) {
    assert.match(command, /argument-hint:\s*"\[--scope-base REF\] \[review prompt\]"/, `${rel} missing scope-base argument hint`);
    assert.match(command, /`--scope-base REF` before `--prompt`/, `${rel} must route scope-base before prompt`);
    assert.match(command, /remaining prompt text to `--prompt`/, `${rel} must exclude scope-base from prompt text`);
    assert.doesNotMatch(command, /--prompt\s+"\$ARGUMENTS"/, `${rel} must not pass all arguments as prompt`);
  }
  if (workflow === "custom-review") {
    assert.match(command, /--scope\s+custom\b/, `${rel} missing custom scope`);
    assert.match(command, /--scope-paths\s+"<file1>,<file2>"/, `${rel} missing scope-path placeholder`);
    assert.match(command, /\$ARGUMENTS/, `${rel} must describe argument handling`);
    assert.match(command, /--scope-paths <files>/, `${rel} must map scope paths from arguments`);
    assert.match(command, /remaining prompt text to `--prompt`/, `${rel} must exclude scope paths from prompt text`);
    assert.match(command, /Replace `<file1>,<file2>`/, `${rel} must tell agents to replace scope-path placeholders`);
    assert.match(command, /comma- or newline-separated concrete relative paths/, `${rel} missing scope-path separator guidance`);
    assert.match(command, /expand globs before running/i, `${rel} missing glob expansion guidance`);
  }
}

const DELEGATION_WORKFLOWS = ["review", "adversarial-review", "rescue", "setup", "status", "result", "cancel"];
const API_REVIEWER_WORKFLOWS = ["review", "adversarial-review", "custom-review", "setup"];

test("marketplace.json: valid schema", () => {
  const m = readJson(".agents/plugins/marketplace.json");
  assert.equal(typeof m.name, "string");
  assert.equal(typeof m.interface.displayName, "string");
  assert.ok(Array.isArray(m.plugins));
  assert.ok(m.plugins.length >= 1);
  for (const p of m.plugins) {
    assert.equal(typeof p.name, "string");
    assert.ok(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.name), `${p.name} not bare`);
    assert.ok(["AVAILABLE", "DEFAULT", "HIDDEN"].includes(p.policy.installation));
    assert.ok(["ON_INSTALL", "ON_USE"].includes(p.policy.authentication));
    assert.ok(["local", "git"].includes(p.source.source));
  }
});

test("claude plugin.json: valid schema", () => {
  const m = readJson("plugins/claude/.codex-plugin/plugin.json");
  assert.equal(m.name, "claude");
  assert.ok(/^\d+\.\d+\.\d+/.test(m.version));
  assert.equal(m.license, "AGPL-3.0-only");
  assert.equal(m.skills, "./skills");
  assert.ok(m.interface.capabilities.every((c) => ["Interactive", "Read", "Write"].includes(c)));
});

test("gemini plugin.json: valid schema", () => {
  const m = readJson("plugins/gemini/.codex-plugin/plugin.json");
  assert.equal(m.name, "gemini");
  assert.ok(/^\d+\.\d+\.\d+/.test(m.version));
  assert.equal(m.license, "AGPL-3.0-only");
  assert.equal(m.skills, "./skills");
});

test("kimi plugin.json: valid schema", () => {
  const m = readJson("plugins/kimi/.codex-plugin/plugin.json");
  assert.equal(m.name, "kimi");
  assert.ok(/^\d+\.\d+\.\d+/.test(m.version));
  assert.equal(m.license, "AGPL-3.0-only");
  assert.equal(m.skills, "./skills");
});

test("api-reviewers plugin.json: valid schema", () => {
  const m = readJson("plugins/api-reviewers/.codex-plugin/plugin.json");
  assert.equal(m.name, "api-reviewers");
  assert.ok(/^\d+\.\d+\.\d+/.test(m.version));
  assert.equal(m.license, "AGPL-3.0-only");
  assert.equal(m.skills, "./skills");
});

test("both plugins declared in marketplace match filesystem layout", () => {
  const m = readJson(".agents/plugins/marketplace.json");
  for (const p of m.plugins) {
    const manifest = readJson(`plugins/${p.name}/.codex-plugin/plugin.json`);
    assert.equal(manifest.name, p.name, `${p.name} directory plugin.json name mismatch`);
  }
});

test("claude, gemini, and kimi package non-ping command docs until upstream slash support lands", () => {
  const commands = [
    "review", "adversarial-review", "rescue",
    "setup", "status", "result", "cancel",
  ];
  for (const plugin of DELEGATION_PLUGINS) {
    for (const command of commands) {
      const rel = `plugins/${plugin}/commands/${plugin}-${command}.md`;
      assert.equal(existsSync(path.join(REPO_ROOT, rel)), true, `${rel} missing`);
    }
    const pingRel = `plugins/${plugin}/commands/${plugin}-ping.md`;
    assert.equal(existsSync(path.join(REPO_ROOT, pingRel)), false, `${pingRel} must stay deferred`);
  }
});

test("claude, gemini, and kimi expose user-invocable skill fallbacks", () => {
  for (const plugin of DELEGATION_PLUGINS) {
    const rel = `plugins/${plugin}/skills/${plugin}-delegation/SKILL.md`;
    const skill = readFileSync(path.join(REPO_ROOT, rel), "utf8");
    assert.match(skill, new RegExp(`name: ${plugin}-delegation`));
    assert.match(skill, /user-invocable: true/);
    assert.match(skill, new RegExp(`${plugin}-companion\\.mjs`));
    assert.match(skill, new RegExp(`${plugin}-companion\\.mjs"\\s+doctor\\b`));
    assertNoBracketedCliFlagsInBash(skill, rel);
    assert.match(skill, /--scope-base REF/, `${rel} missing branch-diff base-ref guidance`);
    if (plugin === "kimi") {
      assert.match(skill, /rescue[\s\S]*--max-steps-per-turn N/, `${rel} must document Kimi rescue step budget`);
    } else {
      assert.doesNotMatch(skill, /--max-steps-per-turn\b/, `${rel} must not document Kimi-only max-step option`);
    }
    assertPickerDescription(skill, rel);
  }
});

test("api-reviewers exposes a user-invocable skill fallback", () => {
  const rel = "plugins/api-reviewers/skills/api-reviewers-delegation/SKILL.md";
  const skill = readFileSync(path.join(REPO_ROOT, rel), "utf8");

  assert.match(skill, /^name:\s*api-reviewers-delegation$/m);
  assert.match(skill, /^user-invocable:\s*true$/m);
  assert.match(skill, /api-reviewer\.mjs/);
  assert.match(skill, /--provider\s+deepseek\b/);
  assert.match(skill, /--provider\s+glm\b/);
  assert.match(skill.match(/^description:\s*(.+)$/m)?.[1] ?? "", /adversarial review/);
  assertNoBracketedCliFlagsInBash(skill, rel);
  assert.doesNotMatch(skill, /--foreground\b/, `${rel} must not document ignored --foreground flag`);
  assert.match(skill, /api-reviewer\.mjs\s+doctor\b/);
  assert.match(skill, /api-reviewer\.mjs\s+run\b/);
  assert.match(skill, /--mode\s+review\b/);
  assert.match(skill, /--mode\s+adversarial-review\b/);
  assert.match(skill, /--mode\s+custom-review\b/);
  assert.match(skill, /--scope-base REF/);
  assert.match(skill, /Replace `<file1>,<file2>`/, `${rel} must tell agents to replace scope-path placeholders`);
  assert.match(skill, /comma- or newline-separated concrete relative paths/, `${rel} missing scope-path separator guidance`);
  assert.match(skill, /external_review.*before the review result/);
  assertPickerDescription(skill, rel);
});

test("provider workflow skills are user-invocable and command-backed", () => {
  for (const plugin of DELEGATION_PLUGINS) {
    for (const workflow of DELEGATION_WORKFLOWS) {
      const skillName = `${plugin}-${workflow}`;
      const rel = `plugins/${plugin}/skills/${skillName}/SKILL.md`;
      const skillPath = path.join(REPO_ROOT, rel);
      assert.equal(existsSync(skillPath), true, `${rel} missing`);
      const skill = readFileSync(skillPath, "utf8");

      assert.match(skill, new RegExp(`^name:\\s*${skillName}$`, "m"));
      assert.match(skill, /^user-invocable:\s*true$/m);
      assertPickerDescription(skill, rel);
      assert.match(skill, new RegExp(`${plugin}-companion\\.mjs`));
      assert.match(skill, new RegExp(`${plugin}:${skillName}`));
      assert.match(skill, new RegExp("`<plugin-root>` is `plugins/" + plugin + "`"));
      if (skill.includes("--cwd")) {
        assert.match(skill, /`<workspace>` is /);
        if (["status", "result", "cancel"].includes(workflow)) {
          assert.match(skill, /`<workspace>` is the workspace where the job was launched/);
          if (["result", "cancel"].includes(workflow)) {
            assert.match(skill, /`<job-id>` is the identifier returned by a background launch or listed by the status workflow/);
          }
        } else if (workflow === "rescue") {
          assert.match(skill, /`<workspace>` is the repository where the rescue task should run/);
        } else {
          assert.match(skill, /`<workspace>` is the repository or bundle directory to review/);
        }
      }
      assert.doesNotMatch(skill, /frontmatter name remains/);
      assertCompanionWorkflowInvocation(skill, plugin, workflow, rel);
      const commandRel = `plugins/${plugin}/commands/${skillName}.md`;
      assert.equal(existsSync(path.join(REPO_ROOT, commandRel)), true, `${commandRel} missing`);
      assert.match(skill, new RegExp(commandRel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  }

  for (const provider of API_REVIEWER_PROVIDERS) {
    for (const workflow of API_REVIEWER_WORKFLOWS) {
      const skillName = `${provider}-${workflow}`;
      const rel = `plugins/api-reviewers/skills/${skillName}/SKILL.md`;
      const skillPath = path.join(REPO_ROOT, rel);
      assert.equal(existsSync(skillPath), true, `${rel} missing`);
      const skill = readFileSync(skillPath, "utf8");

      assert.match(skill, new RegExp(`^name:\\s*${skillName}$`, "m"));
      assert.match(skill, /^user-invocable:\s*true$/m);
      assertPickerDescription(skill, rel);
      assert.match(skill, /api-reviewer\.mjs/);
      assert.match(skill, new RegExp(`api-reviewers:${skillName}`));
      assertApiReviewerWorkflowInvocation(skill, provider, workflow, rel);
      const commandRel = `plugins/api-reviewers/commands/${skillName}.md`;
      assert.equal(existsSync(path.join(REPO_ROOT, commandRel)), true, `${commandRel} missing`);
      const command = readFileSync(path.join(REPO_ROOT, commandRel), "utf8");
      assertApiReviewerCommandDoc(command, workflow, commandRel);
      assert.match(skill, new RegExp(commandRel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  }
});

test("README documents install verification for discoverable delegation skills", () => {
  const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
  assert.match(readme, /Verify skill discovery after installation/);
  assert.match(readme, /codex debug prompt-input 'list skills'/);
  assert.match(readme, /claude:claude-delegation/);
  assert.match(readme, /gemini:gemini-delegation/);
  assert.match(readme, /kimi:kimi-delegation/);
  assert.match(readme, /api-reviewers:api-reviewers-delegation/);
  assert.match(readme, /CODEX_HOME/);
});

test("README documents workflow-specific skill picker UX", () => {
  const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");

  assert.match(readme, /<plugin>:<provider-workflow>/);
  assert.match(readme, /workflow-specific skills/);
  assert.match(readme, /slash-command files remain packaged/i);
  assert.match(readme, /advanced `custom-review` and `preflight` flows/);
  assert.match(readme, /remain available through those broad delegation skills/);
  for (const plugin of DELEGATION_PLUGINS) {
    for (const workflow of DELEGATION_WORKFLOWS) {
      const skill = `${plugin}:${plugin}-${workflow}`;
      assert.match(readme, new RegExp(`\\b${skill}\\b`), `README missing ${skill}`);
    }
  }
  for (const provider of API_REVIEWER_PROVIDERS) {
    for (const workflow of API_REVIEWER_WORKFLOWS) {
      const skill = `api-reviewers:${provider}-${workflow}`;
      assert.match(readme, new RegExp(`\\b${skill}\\b`), `README missing ${skill}`);
    }
  }
});

test("release docs disclose current Codex slash-command limitation", () => {
  const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
  const changelog = readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
  const releaseVerification = readFileSync(path.join(REPO_ROOT, "docs/release-verification.md"), "utf8");

  const limitation = /Codex CLI 0\.125\.0 does not currently expose plugin `commands\/\*\.md` files as TUI slash commands/;
  assert.match(readme, limitation);
  assert.match(readme, /user-invocable skill fallback/);
  assert.match(changelog, limitation);
  assert.match(releaseVerification, /Root cause confirmed/);
  assert.match(releaseVerification, /find_builtin_command/);
});

test("release metadata documents v0.1.0 for both plugins", () => {
  const changelog = readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
  const rootPackage = readJson("package.json");
  assert.equal(rootPackage.version, "0.1.0");
  for (const plugin of ["claude", "gemini", "kimi", "api-reviewers"]) {
    const manifest = readJson(`plugins/${plugin}/.codex-plugin/plugin.json`);
    const workspacePackage = readJson(`plugins/${plugin}/package.json`);
    assert.equal(manifest.version, "0.1.0");
    assert.equal(workspacePackage.version, manifest.version);
  }

  assert.match(changelog, /## 0\.1\.0/);
  assert.match(changelog, /Features shipped/i);
  assert.match(changelog, /Known limitations/i);
  assert.match(changelog, /Upstream attribution/i);
  assert.match(changelog, /openai\/codex-plugin-cc/);
});
