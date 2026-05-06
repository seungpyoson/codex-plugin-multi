import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  REVIEW_AUDIT_MANIFEST_VERSION,
  REVIEW_PROMPT_CHECKLIST,
  buildReviewAuditManifest,
  buildReviewPrompt,
  scopeResolutionReason,
} from "../../scripts/lib/review-prompt.mjs";

const REVIEW_PROMPT_MODULES = Object.freeze([
  ["shared", "scripts/lib/review-prompt.mjs"],
  ["api-reviewers", "plugins/api-reviewers/scripts/lib/review-prompt.mjs"],
  ["claude", "plugins/claude/scripts/lib/review-prompt.mjs"],
  ["gemini", "plugins/gemini/scripts/lib/review-prompt.mjs"],
  ["grok", "plugins/grok/scripts/lib/review-prompt.mjs"],
  ["kimi", "plugins/kimi/scripts/lib/review-prompt.mjs"],
]);

test("review prompt packaging copies match the shared source byte-for-byte", () => {
  const shared = readFileSync(resolve("scripts/lib/review-prompt.mjs"), "utf8");
  for (const [name, file] of REVIEW_PROMPT_MODULES.slice(1)) {
    assert.equal(readFileSync(resolve(file), "utf8"), shared, `${name} review-prompt copy drifted`);
  }
});

for (const [name, file] of REVIEW_PROMPT_MODULES) {
  test(`review prompt contract includes exact identity and checklist metadata (${name})`, async () => {
    const {
      REVIEW_PROMPT_CHECKLIST: targetChecklist,
      buildReviewPrompt: targetBuildReviewPrompt,
    } = await import(pathToFileURL(resolve(file)).href);
    assert.deepEqual(targetChecklist, REVIEW_PROMPT_CHECKLIST);
    assertReviewPromptContract(targetBuildReviewPrompt, targetChecklist);
  });
}

function assertReviewPromptContract(targetBuildReviewPrompt = buildReviewPrompt, targetChecklist = REVIEW_PROMPT_CHECKLIST) {
  const prompt = targetBuildReviewPrompt({
    provider: "Gemini CLI",
    mode: "adversarial-review",
    repository: "seungpyoson/codex-plugin-multi",
    baseRef: "origin/main",
    baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    headRef: "feature/review-quality",
    headCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    scope: "branch-diff",
    scopePaths: ["plugins/gemini/scripts/gemini-companion.mjs"],
    userPrompt: "Focus on control-flow bugs.",
  });

  assert.match(prompt, /Provider: Gemini CLI/);
  assert.match(prompt, /Mode: adversarial-review/);
  assert.match(prompt, /Repository: seungpyoson\/codex-plugin-multi/);
  assert.match(prompt, /Base ref: origin\/main/);
  assert.match(prompt, /Base commit: a{40}/);
  assert.match(prompt, /Head ref: feature\/review-quality/);
  assert.match(prompt, /Head commit: b{40}/);
  assert.match(prompt, /Scope: branch-diff/);
  assert.match(prompt, /plugins\/gemini\/scripts\/gemini-companion\.mjs/);
  assert.match(prompt, /Checklist/);
  for (const item of targetChecklist) {
    assert.match(prompt, new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(prompt, /For every checklist item, report PASS, FAIL, or NOT REVIEWED/);
  assert.match(prompt, /supplied in this prompt as the authoritative review evidence/);
  assert.match(prompt, /git, GitHub, network, filesystem, or tool access is unavailable/);
  assert.match(prompt, /mark only that check as NOT REVIEWED/);
  assert.match(prompt, /Do not report missing external tool access as a blocking code finding by itself/);
  assert.match(prompt, /runtime\/tool limitations/);
  assert.match(prompt, /Blocking findings first/);
  assert.match(prompt, /Timed out, truncated, interrupted, blocked, or shallow output is NOT an approval/);
  assert.match(prompt, /User prompt:\nFocus on control-flow bugs\./);
}

for (const [name, file] of REVIEW_PROMPT_MODULES) {
  test(`review audit manifest stores hashes and counts without prompt or source text (${name})`, async () => {
    const {
      REVIEW_AUDIT_MANIFEST_VERSION: targetManifestVersion,
      buildReviewAuditManifest: targetBuildReviewAuditManifest,
    } = await import(pathToFileURL(resolve(file)).href);
    assertReviewAuditManifest(targetBuildReviewAuditManifest, targetManifestVersion);
  });

  test(`review audit manifest source hashes are byte-accurate for buffers (${name})`, async () => {
    const {
      buildReviewAuditManifest: targetBuildReviewAuditManifest,
    } = await import(pathToFileURL(resolve(file)).href);
    const manifest = targetBuildReviewAuditManifest({
      prompt: "prompt",
      sourceFiles: [
        { path: "asset.bin", content: Buffer.from([0xff, 0x00, 0x0a, 0x41]) },
      ],
    });

    assert.deepEqual(manifest.selected_source.files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      lines: file.lines,
      hash: file.content_hash.value,
    })), [
      {
        path: "asset.bin",
        bytes: 4,
        lines: 2,
        hash: "db8b50cdd33e826dfdbd1bc0a7f3650352a9f5f160a4be00104133360c2375ac",
      },
    ]);
  });

  test(`review audit manifest quality parser covers bounded token branches (${name})`, async () => {
    const {
      buildReviewAuditManifest: targetBuildReviewAuditManifest,
    } = await import(pathToFileURL(resolve(file)).href);
    const manifest = targetBuildReviewAuditManifest({
      prompt: "prompt",
      sourceFiles: [
        { path: "crlf.txt", text: "one\rtwo\r\nthree\n" },
      ],
      result: [
        "verdict missing colon",
        "Summary : rejected after review",
        "approved_by_cache should not count as a verdict token",
        "- NOT REVIEWED item",
        "* FAIL item",
        "1) PASS item",
        "2 PASS missing delimiter",
        "3. PASS_THROUGH should not count",
        "Blocking findings",
        "Residual risks",
      ].join("\r\n"),
      status: "completed",
    });

    assert.deepEqual(manifest.selected_source.totals, { files: 1, bytes: 15, lines: 3 });
    assert.equal(manifest.review_quality.has_verdict, true);
    assert.equal(manifest.review_quality.has_blocking_section, true);
    assert.equal(manifest.review_quality.has_non_blocking_section, true);
    assert.equal(manifest.review_quality.checklist_items_seen, 3);
  });
}

function assertReviewAuditManifest(
  targetBuildReviewAuditManifest = buildReviewAuditManifest,
  targetManifestVersion = REVIEW_AUDIT_MANIFEST_VERSION,
) {
  const manifest = targetBuildReviewAuditManifest({
    prompt: "final rendered prompt with selected source",
    sourceFiles: [
      { path: "src/a.js", text: "one\ntwo\n" },
      { path: "src/b.js", text: "" },
    ],
    git: {
      remote: "git@github.com:seungpyoson/codex-plugin-multi.git",
      branch: "fix/issues-76-77-reviewer-ux",
      baseRef: "origin/main",
      baseCommit: "a".repeat(40),
      headRef: "feature",
      headCommit: "b".repeat(40),
      diffStat: "src/a.js | 2 ++",
    },
    promptBuilder: {
      contractVersion: 1,
      pluginVersion: "0.1.0",
      pluginCommit: "b".repeat(40),
    },
    request: {
      provider: "DeepSeek",
      model: "deepseek-v4-pro",
      timeoutMs: 120000,
      maxTokens: 65536,
      temperature: 0,
    },
    truncation: {
      prompt: false,
      source: false,
      output: true,
      outputAtChars: 1000,
    },
    providerIds: {
      requestId: "req-123",
      sessionId: "chatcmpl-123",
    },
    scope: {
      name: "branch-diff",
      base: "origin/main",
      paths: ["src/a.js", "src/b.js"],
      reason: "git diff -z --name-only origin/main...HEAD --",
    },
    result: "Verdict: reject\nBlocking findings\n- bug\nNon-blocking concerns\n- n/a\n1. PASS\n2. PASS\n3. FAIL",
    status: "completed",
    errorCode: null,
  });

  assert.equal(manifest.schema_version, targetManifestVersion);
  assert.equal(manifest.rendered_prompt_hash.algorithm, "sha256");
  assert.match(manifest.rendered_prompt_hash.value, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.selected_source.totals, { files: 2, bytes: 8, lines: 2 });
  assert.deepEqual(manifest.selected_source.files.map((file) => ({
    path: file.path,
    bytes: file.bytes,
    lines: file.lines,
    hashOk: /^[a-f0-9]{64}$/.test(file.content_hash.value),
  })), [
    { path: "src/a.js", bytes: 8, lines: 2, hashOk: true },
    { path: "src/b.js", bytes: 0, lines: 0, hashOk: true },
  ]);
  assert.equal(manifest.git_identity.head_sha, "b".repeat(40));
  assert.equal(manifest.prompt_builder.contract_version, 1);
  assert.equal(manifest.request.model, "deepseek-v4-pro");
  assert.equal(manifest.truncation.output, true);
  assert.equal(manifest.provider_ids.session_id, "chatcmpl-123");
  assert.equal(manifest.scope_resolution.reason, "git diff -z --name-only origin/main...HEAD --");
  assert.equal(manifest.review_quality.has_verdict, true);
  assert.equal(manifest.review_quality.has_blocking_section, true);
  assert.equal(manifest.review_quality.has_non_blocking_section, true);
  assert.equal(manifest.review_quality.checklist_items_seen >= 3, true);
  assert.equal(JSON.stringify(manifest).includes("final rendered prompt"), false);
  assert.equal(JSON.stringify(manifest).includes("one\\ntwo"), false);
}

test("review quality verdict ignores incidental pass/fail prose", () => {
  const manifest = buildReviewAuditManifest({
    prompt: "rendered prompt",
    sourceFiles: [],
    result: "The unit test passes, but the network request may fail under timeout.",
    status: "completed",
  });

  assert.equal(manifest.review_quality.has_verdict, false);
});

test("review audit manifest does not count approval requests as failed review slots", () => {
  const manifest = buildReviewAuditManifest({
    prompt: "approval prompt",
    sourceFiles: [],
    status: "approval_request",
  });

  assert.equal(manifest.review_quality.failed_review_slot, false);
});

for (const [name, file] of REVIEW_PROMPT_MODULES) {
  test(`scope resolution reason falls back to scope name without explicit paths (${name})`, async () => {
    const {
      scopeResolutionReason: targetScopeResolutionReason,
    } = file === "scripts/lib/review-prompt.mjs"
      ? { scopeResolutionReason }
      : await import(pathToFileURL(resolve(file)).href);

    assert.equal(targetScopeResolutionReason({
      scope: "branch-diff",
      scope_base: "origin/main",
      scope_paths: [],
    }), "git diff -z --name-only origin/main...HEAD --");
    assert.equal(targetScopeResolutionReason({
      scope: "branch-diff",
      scope_base: "origin/main",
      scope_paths: ["src/a.js"],
    }), "git diff -z --name-only origin/main...HEAD -- filtered by explicit --scope-paths");
    assert.equal(targetScopeResolutionReason({
      scope: "custom",
      scope_base: null,
      scope_paths: ["src/a.js"],
    }), "explicit --scope-paths");
    assert.equal(targetScopeResolutionReason({
      scope: "working-tree",
      scope_base: null,
      scope_paths: [],
    }), "working-tree");
  });
}
