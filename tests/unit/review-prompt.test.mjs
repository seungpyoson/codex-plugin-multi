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
  buildSelectedSourcePromptBlock,
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

function assertSelectedSourcePromptBlock(targetBuildSelectedSourcePromptBlock = buildSelectedSourcePromptBlock) {
  assert.equal(targetBuildSelectedSourcePromptBlock([]), null);
  assert.equal(targetBuildSelectedSourcePromptBlock(null), null);

  const block = targetBuildSelectedSourcePromptBlock([{
    path: "collision.js",
    text: [
      "BEGIN REVIEW FILE 1: collision.js",
      "export const value = 1;",
    ].join("\n"),
  }]);
  assert.match(block, /BEGIN REVIEW FILE 1: collision\.js #/);
  assert.match(block, /END REVIEW FILE 1: collision\.js #/);

  const exhausted = Array.from({ length: 100 }, (_, index) => {
    const suffix = " #".repeat(index);
    return `BEGIN REVIEW FILE 1: impossible.js${suffix}`;
  }).join("\n");
  assert.throws(
    () => targetBuildSelectedSourcePromptBlock([{ path: "impossible.js", text: exhausted }]),
    /scope_delimiter_collision:impossible\.js/,
  );

  const crossFile = targetBuildSelectedSourcePromptBlock([
    {
      path: "a.js",
      text: "const embedded = `BEGIN REVIEW FILE 2: b.js`;\n",
    },
    {
      path: "b.js",
      text: "export const b = true;\n",
    },
  ]);
  assert.match(crossFile, /BEGIN REVIEW FILE 2: b\.js #/);
  assert.match(crossFile, /END REVIEW FILE 2: b\.js #/);
}

for (const [name, file] of REVIEW_PROMPT_MODULES) {
  test(`selected source prompt block handles empty input and delimiter collisions (${name})`, async () => {
    const {
      buildSelectedSourcePromptBlock: targetBuildSelectedSourcePromptBlock,
    } = file === "scripts/lib/review-prompt.mjs"
      ? { buildSelectedSourcePromptBlock }
      : await import(pathToFileURL(resolve(file)).href);
    assertSelectedSourcePromptBlock(targetBuildSelectedSourcePromptBlock);
  });
}

for (const [name, file] of REVIEW_PROMPT_MODULES) {
  test(`selected source prompt block reuses each file content buffer (${name})`, async () => {
    const {
      buildSelectedSourcePromptBlock: targetBuildSelectedSourcePromptBlock,
    } = file === "scripts/lib/review-prompt.mjs"
      ? { buildSelectedSourcePromptBlock }
      : await import(pathToFileURL(resolve(file)).href);

    let reads = 0;
    const block = targetBuildSelectedSourcePromptBlock([{
      path: "once.js",
      get content() {
        reads += 1;
        return Buffer.from("export const once = true;\n");
      },
    }]);

    assert.equal(reads, 1);
    assert.match(block, /BEGIN REVIEW FILE 1: once\.js/);
    assert.match(block, /export const once = true;/);
    assert.match(block, /END REVIEW FILE 1: once\.js/);
  });
}

for (const [name, file] of REVIEW_PROMPT_MODULES) {
  test(`semantic failure helper has no unused lowerText parameter (${name})`, () => {
    const source = readFileSync(resolve(file), "utf8");
    assert.doesNotMatch(source, /function semanticFailureReasons\(text,\s*lowerText,/);
    assert.doesNotMatch(source, /semanticFailureReasons\(text,\s*lowerText,/);
  });
}

for (const [name, file] of REVIEW_PROMPT_MODULES) {
  test(`selected-source path matching avoids per-file RegExp construction (${name})`, () => {
    const source = readFileSync(resolve(file), "utf8");
    const match = /function includesPathToken[\s\S]*?\n}\n\nfunction mentionsSelectedSourcePath/.exec(source);
    assert.ok(match, `expected includesPathToken in ${name}`);
    assert.doesNotMatch(match[0], /new RegExp/);
  });
}

for (const [name, file] of REVIEW_PROMPT_MODULES) {
  test(`selected-source inspection reuses path matcher (${name})`, () => {
    const source = readFileSync(resolve(file), "utf8");
    const match = /function mentionsSelectedSourceInspection[\s\S]*?\n}\n\nconst TINY_SOURCE_MAX_FILES/.exec(source);
    assert.ok(match, `expected mentionsSelectedSourceInspection in ${name}`);
    assert.match(match[0], /mentionsSelectedSourcePath\(lowerText, selectedSource\)/);
    assert.doesNotMatch(match[0], /includesPathToken/);
  });
}

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
  assert.match(prompt, /must name the selected file path\(s\) inspected/);
  assert.match(prompt, /bare numbered answers or section bodies such as only 'None' are shallow and invalid/);
  assert.match(prompt, /write a complete sentence that names the relevant selected file or scope/);
  assert.match(prompt, /supplied in this prompt as the authoritative review evidence/);
  assert.match(prompt, /git, GitHub, network, filesystem, or tool access is unavailable/);
  assert.match(prompt, /mark only that check as NOT REVIEWED/);
  assert.match(prompt, /Do not report missing external tool access as a blocking code finding by itself/);
  assert.match(prompt, /runtime\/tool limitations/);
  assert.match(prompt, /Blocking findings first/);
  assert.match(prompt, /overlapping predicates, early returns, and branch ordering/);
  assert.match(prompt, /Do not upgrade speculative input-validation hardening into a blocking finding/);
  assert.match(prompt, /APPROVE with non-blocking concerns or test gaps when code is acceptable/);
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

  test(`review audit manifest flags selected-path inspection denial (${name})`, async () => {
    const {
      buildReviewAuditManifest: targetBuildReviewAuditManifest,
    } = await import(pathToFileURL(resolve(file)).href);
    const manifest = targetBuildReviewAuditManifest({
      prompt: "rendered prompt",
      sourceFiles: [{ path: "src/selected.js", text: "export const selected = true;\n" }],
      result: [
        "Verdict: APPROVE",
        "Blocking findings",
        "- No blocking findings claimed because src/selected.js was not inspected.",
        "Non-blocking concerns",
        "- None. The review output is intentionally long enough to avoid the shallow-output classifier so this regression isolates selected-path inspection denial.",
        "Test gaps",
        "- None beyond the failed selected-file inspection signal under test.",
        "Inspection statement",
        "- src/selected.js was not inspected, so this completed transport must not be accepted as a successful review.",
        "Checklist",
        "1. PASS exact base/head metadata was not relevant to this unit fixture.",
        "2. FAIL selected source inspection did not complete for src/selected.js.",
        "3. NOT REVIEWED correctness/security review was not performed.",
        "4. NOT REVIEWED no review comments were supplied.",
        "5. PASS blocking and non-blocking sections are separated.",
        "6. PASS no timeout, truncation, interruption, or permission block text is needed for this selected-path denial regression.",
      ].join("\n"),
      status: "completed",
      errorCode: null,
    });

    assert.equal(manifest.review_quality.failed_review_slot, true);
    assert.deepEqual(manifest.review_quality.semantic_failure_reasons, ["not_reviewed"]);
  });

  test(`review prompt audit covers defensive quality branches (${name})`, async () => {
    const {
      buildReviewAuditManifest: targetBuildReviewAuditManifest,
      buildReviewPrompt: targetBuildReviewPrompt,
    } = await import(pathToFileURL(resolve(file)).href);

    const prompt = targetBuildReviewPrompt({
      provider: null,
      mode: "custom-review",
      scope: "custom",
      scopePaths: [],
      extraInstructions: ["Use the same structured sections as the reviewer contract."],
    });
    assert.match(prompt, /Provider: unknown/);
    assert.match(prompt, /Scope paths\n- unknown/);
    assert.match(prompt, /Provider-specific instructions\n- Use the same structured sections as the reviewer contract\./);
    assert.doesNotMatch(prompt, /User prompt:/);

    const denied = targetBuildReviewAuditManifest({
      prompt: "rendered prompt",
      sourceFiles: [
        { path: "src/a.js", text: "export const a = 1;\n" },
        { path: "src/b.js", text: "export const b = 2;\n" },
      ],
      result: [
        "Verdict: NOT REVIEWED",
        "Blocking findings",
        "- No blocking code finding is claimed because permission denied prevented file access.",
        "Non-blocking concerns",
        "- None.",
        "Checklist",
        "1. Verify exact base/head refs and commits before judging the diff: NOT REVIEWED because metadata was unavailable.",
        "2. Review only the declared scope and list any scope gaps as NOT REVIEWED: PASS.",
      ].join("\n"),
      status: "completed",
      errorCode: null,
    });
    assert.equal(denied.review_quality.semantic_failure_reasons.includes("not_reviewed"), true);
    assert.equal(denied.review_quality.semantic_failure_reasons.includes("permission_blocked"), true);
    assert.equal(denied.review_quality.checklist_items_seen, 2);

    const genericSelectedFileDenied = targetBuildReviewAuditManifest({
      prompt: "rendered prompt",
      sourceFiles: [{ path: "src/generic.js", text: "export const generic = true;\n" }],
      result: [
        "Verdict: APPROVE",
        "Blocking findings",
        "- No blocking findings claimed because the selected file was not inspected.",
        "Non-blocking concerns",
        "- None. This fixture intentionally omits the concrete path in the denial sentence so the generic selected-file fallback is covered.",
        "Test gaps",
        "- None beyond the generic selected-file denial signal under test.",
        "Inspection statement",
        "- The selected file was not inspected, so this completed transport must fail closed.",
        "Checklist",
        "1. PASS exact metadata was not relevant to this fixture.",
        "2. FAIL selected file inspection did not complete.",
        "3. NOT REVIEWED correctness/security review was not performed.",
        "4. NOT REVIEWED no prior review comments were supplied.",
        "5. PASS sections were separated.",
        "6. PASS no timeout, truncation, interruption, or permission block occurred.",
      ].join("\n"),
      status: "completed",
      errorCode: null,
    });
    assert.equal(genericSelectedFileDenied.review_quality.semantic_failure_reasons.includes("not_reviewed"), true);

    const missingVerdict = targetBuildReviewAuditManifest({
      prompt: "rendered prompt",
      sourceFiles: [{ path: "src/no-verdict.js", text: "export const ok = true;\n" }],
      result: [
        "Blocking findings",
        "- No blocking findings were reported for src/no-verdict.js after inspection.",
        "Non-blocking concerns",
        "- No non-blocking concerns were reported for src/no-verdict.js.",
        "Test gaps",
        "- No test gaps were reported for src/no-verdict.js.",
        "Inspection statement",
        "- I inspected src/no-verdict.js but omitted the verdict header, which must fail closed.",
        "Checklist",
        "1. PASS exact metadata was not relevant to this fixture.",
        "2. PASS declared scope was inspected.",
        "3. PASS no blocker was invented.",
        "4. NOT REVIEWED no prior review comments were supplied.",
        "5. PASS sections were separated.",
        "6. PASS no timeout, truncation, interruption, permission block, or shallow output occurred.",
      ].join("\n"),
      status: "completed",
      errorCode: null,
    });
    assert.equal(missingVerdict.review_quality.has_verdict, false);
    assert.deepEqual(missingVerdict.review_quality.semantic_failure_reasons, ["missing_verdict"]);

    const conciseTiny = targetBuildReviewAuditManifest({
      prompt: "rendered prompt",
      sourceFiles: [{ path: "README.md", text: "# E2E\n" }],
      result: [
        "Verdict: APPROVE.",
        "Blocking findings: No blocking findings apply to README.md.",
        "Non-blocking concerns: None for README.md.",
        "Inspection statement: I inspected README.md.",
      ].join("\n"),
      status: "completed",
      errorCode: null,
    });
    assert.equal(conciseTiny.review_quality.looks_shallow, false);
    assert.equal(conciseTiny.review_quality.failed_review_slot, false);

    const conciseTinySynonym = targetBuildReviewAuditManifest({
      prompt: "rendered prompt",
      sourceFiles: [{ path: "README.md", text: "# E2E\n" }],
      result: [
        "Verdict: APPROVE.",
        "Blocking findings: No blocking findings apply to README.md.",
        "Non-blocking concerns: None for README.md.",
        "Inspection statement: I examined README.md.",
      ].join("\n"),
      status: "completed",
      errorCode: null,
    });
    assert.equal(conciseTinySynonym.review_quality.looks_shallow, false);
    assert.equal(conciseTinySynonym.review_quality.failed_review_slot, false);

    const substringPathMention = targetBuildReviewAuditManifest({
      prompt: "rendered prompt",
      sourceFiles: [{ path: "a.js", text: "x\n" }],
      result: [
        "Verdict: APPROVE.",
        "Blocking findings: No blocking findings apply.",
        "Non-blocking concerns: None.",
        "Inspection statement: I inspected data.js.",
      ].join("\n"),
      status: "completed",
      errorCode: null,
    });
    assert.equal(substringPathMention.review_quality.looks_shallow, true);
    assert.deepEqual(substringPathMention.review_quality.semantic_failure_reasons, ["shallow_output"]);
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
  assert.deepEqual(manifest.review_quality.semantic_failure_reasons, ["shallow_output", "missing_verdict"]);
  assert.equal(manifest.review_quality.failed_review_slot, true);
});

test("review quality parser does not treat compact hyphen prefixes as markdown bullets", () => {
  const manifest = buildReviewAuditManifest({
    prompt: "rendered prompt",
    sourceFiles: [{ path: "-Verdict", text: "literal leading hyphen path\n" }],
    result: [
      "-Verdict: APPROVE is a literal selected path label, not a verdict section.",
      "Blocking findings: none.",
      "Non-blocking concerns: none.",
      "I inspected -Verdict.",
    ].join("\n"),
    status: "completed",
  });

  assert.equal(manifest.review_quality.has_verdict, false);
  assert.equal(manifest.review_quality.failed_review_slot, true);
  assert.equal(manifest.review_quality.semantic_failure_reasons.includes("missing_verdict"), true);
});

test("review audit manifest accepts markdown-bold verdict labels with colon outside bold", () => {
  const manifest = buildReviewAuditManifest({
    prompt: "rendered prompt",
    sourceFiles: [{ path: "sample.js", text: "export const value = 1;\n" }],
    result: [
      "1. **Verdict**: REQUEST CHANGES",
      "2. **Blocking findings**",
      "- In `sample.js`, the exported value is wrong.",
      "3. **Non-blocking concerns**",
      "- In `sample.js`, none.",
    ].join("\n"),
    status: "completed",
    errorCode: null,
  });

  assert.equal(manifest.review_quality.has_verdict, true);
});

test("review audit manifest accepts bold-wrapped numbered verdict labels", () => {
  const manifest = buildReviewAuditManifest({
    prompt: "rendered prompt",
    sourceFiles: [{ path: "README.md", text: "# E2E\n" }],
    result: [
      "**1. Verdict: APPROVE**",
      "**2. Blocking findings**",
      "No blocking findings in README.md.",
      "**3. Non-blocking concerns**",
      "No non-blocking concerns apply to README.md.",
      "**5. File inspection**",
      "I inspected README.md.",
    ].join("\n"),
    status: "completed",
    errorCode: null,
  });

  assert.equal(manifest.review_quality.has_verdict, true);
  assert.deepEqual(manifest.review_quality.semantic_failure_reasons, []);
  assert.equal(manifest.review_quality.failed_review_slot, false);
});

test("review audit manifest accepts markdown verdicts and scoped NOT REVIEWED gaps", () => {
  const manifest = buildReviewAuditManifest({
    prompt: "rendered prompt",
    sourceFiles: [{ path: "README.md", text: "# E2E\n" }],
    result: [
      "1. **Verdict:** APPROVE",
      "2. **Blocking findings:** No blocking findings.",
      "3. **Non-blocking concerns:** The README is intentionally minimal for an E2E fixture; no product documentation issue is blocking.",
      "4. **Test gaps or verification gaps:** None for this generated smoke packet.",
      "5. **File inspection:** Yes, I inspected the selected file `README.md` as supplied inline in the prompt.",
      "",
      "Checklist results:",
      "- Verify base/head refs and commits: NOT REVIEWED because no comparison base was supplied for this single-file smoke packet.",
      "- Review only the declared scope and list any scope gaps as NOT REVIEWED. - PASS; only README.md was supplied and inspected.",
      "- Correctness bugs, security risks, regressions, missing tests: PASS; no code behavior exists in this markdown fixture.",
      "- Known review comments or residual threads: NOT REVIEWED because no prior review threads were supplied.",
      "- Separate blocking vs non-blocking: PASS.",
      "- Treat timeout, truncation, interruption, permission block, or shallow output as a failed review slot. - PASS.",
    ].join("\n"),
    status: "completed",
    errorCode: null,
  });

  assert.equal(manifest.review_quality.has_verdict, true);
  assert.equal(manifest.review_quality.looks_shallow, false);
  assert.deepEqual(manifest.review_quality.semantic_failure_reasons, []);
  assert.equal(manifest.review_quality.failed_review_slot, false);
});

test("review audit manifest accepts out-of-scope NOT REVIEWED prose after selected-file inspection", () => {
  const manifest = buildReviewAuditManifest({
    prompt: "rendered prompt",
    sourceFiles: [{ path: "README.md", text: "# E2E\n" }],
    result: [
      "1. **Verdict:** APPROVE.",
      "2. **Blocking findings:** No blocking findings.",
      "3. **Non-blocking concerns:**",
      "- Scope metadata gaps: Base ref and commit are unknown, so a full diff-against-base review is NOT REVIEWED; only the supplied selected file was evaluated.",
      "4. **Test gaps / verification gaps:** None.",
      "5. **Inspection statement:** Yes — I inspected the selected file `README.md` as supplied inline in the prompt.",
      "I did not inspect any other repository files because none were declared in scope.",
      "",
      "Checklist results:",
      "- Known review comments / residual threads: NOT REVIEWED — none supplied in the prompt.",
      "- No timeout/truncation/interruption/permission block/shallow output occurred: PASS.",
    ].join("\n"),
    status: "completed",
    errorCode: null,
  });

  assert.equal(manifest.review_quality.looks_shallow, false);
  assert.deepEqual(manifest.review_quality.semantic_failure_reasons, []);
  assert.equal(manifest.review_quality.failed_review_slot, false);
});

test("review audit manifest ignores markdown PASS checklist lines with failure terms", () => {
  const manifest = buildReviewAuditManifest({
    prompt: "rendered prompt",
    sourceFiles: [{ path: "sample.js", text: "export function add(a, b) {\n  return a - b;\n}\n" }],
    result: [
      "1. Verdict: REQUEST CHANGES",
      "2. Blocking findings:",
      "* In the file `sample.js`, the function `add(a, b)` returns `a - b` instead of adding.",
      "3. Non-blocking concerns:",
      "* In the file `sample.js`, no non-blocking concerns apply.",
      "4. Test gaps or verification gaps:",
      "* The file `sample.js` lacks unit tests for add.",
      "5. Explicit inspection statement:",
      "* I explicitly inspected the file `sample.js`.",
      "",
      "### Review Checklist Evaluation",
      "1. Verify exact base/head refs and commits before judging the diff: **NOT REVIEWED** (Base ref and commit are unknown).",
      "2. Review only the declared scope and list any scope gaps as NOT REVIEWED: **PASS** (The scope is limited to `sample.js`).",
      "3. Evaluate correctness bugs, security risks, regressions, and missing tests: **FAIL** (A correctness bug was found in `sample.js`).",
      "4. Check known review comments or residual threads when the prompt includes them: **NOT REVIEWED** (No review comments were supplied).",
      "5. Separate blocking findings from non-blocking concerns: **PASS**.",
      "6. Treat timeout, truncation, interruption, permission block, or shallow output as a failed review slot: **PASS**.",
    ].join("\n"),
    status: "completed",
    errorCode: null,
  });

  assert.equal(manifest.review_quality.checklist_items_seen, 6);
  assert.deepEqual(manifest.review_quality.semantic_failure_reasons, []);
  assert.equal(manifest.review_quality.failed_review_slot, false);
});

test("review audit manifest ignores en-dash PASS checklist lines with failure terms", () => {
  const manifest = buildReviewAuditManifest({
    prompt: "rendered prompt",
    sourceFiles: [{ path: "sample.js", text: "export function add(a, b) {\n  return a - b;\n}\n" }],
    result: [
      "**Checklist**",
      "1. **Verify exact base/head refs and commits before judging the diff.** – NOT REVIEWED The supplied metadata lists unknown refs.",
      "2. **Review only the declared scope and list any scope gaps as NOT REVIEWED.** – PASS The review is limited to `sample.js`.",
      "3. **Evaluate correctness bugs, security risks, regressions, and missing tests.** – FAIL `sample.js` returns `a - b`.",
      "4. **Check known review comments or residual threads when the prompt includes them.** – NOT REVIEWED No comments were supplied.",
      "5. **Separate blocking findings from non-blocking concerns.** – PASS",
      "6. **Treat timeout, truncation, interruption, permission block, or shallow output as a failed review slot.** – PASS No such failure occurred.",
      "",
      "**Verdict**: REQUEST CHANGES",
      "**Blocking findings**",
      "- `sample.js` function `add` subtracts instead of adding.",
      "**Non-blocking concerns**",
      "- No non-blocking concerns apply to `sample.js`.",
      "**Inspection statement**",
      "- I inspected `sample.js`.",
    ].join("\n"),
    status: "completed",
    errorCode: null,
  });

  assert.equal(manifest.review_quality.checklist_items_seen, 6);
  assert.deepEqual(manifest.review_quality.semantic_failure_reasons, []);
  assert.equal(manifest.review_quality.failed_review_slot, false);
});

test("review audit manifest ignores pathologically long numbered checklist prefixes", () => {
  const manifest = buildReviewAuditManifest({
    prompt: "rendered prompt",
    sourceFiles: [{ path: "sample.js", text: "export const value = 1;\n" }],
    result: [
      "Verdict: APPROVE",
      "Blocking findings: none.",
      "Non-blocking concerns: none.",
      "Inspection statement: I inspected sample.js.",
      "12345678901. PASS This overlong numeric prefix is treated as prose, not a checklist item.",
    ].join("\n"),
    status: "completed",
    errorCode: null,
  });

  assert.equal(manifest.review_quality.checklist_items_seen, 0);
  assert.deepEqual(manifest.review_quality.semantic_failure_reasons, []);
  assert.equal(manifest.review_quality.failed_review_slot, false);
});

test("review audit manifest does not count approval requests as failed review slots", () => {
  const manifest = buildReviewAuditManifest({
    prompt: "approval prompt",
    sourceFiles: [],
    status: "approval_request",
  });

  assert.equal(manifest.review_quality.failed_review_slot, false);
});

test("review audit manifest fails completed slots that did not inspect the selected files", () => {
  const manifest = buildReviewAuditManifest({
    prompt: "rendered prompt",
    sourceFiles: [{ path: "packet.js", text: "export const value = 1;\n" }],
    result: [
      "Verdict: NOT REVIEWED / failed review slot.",
      "Blocking findings",
      "- NOT REVIEWED: Scope is unreachable; the target file was not present in accessible working directories.",
      "Non-blocking concerns",
      "- n/a",
      "1. FAIL exact scope was not inspected",
      "2. NOT REVIEWED correctness/security review was not performed",
    ].join("\n"),
    status: "completed",
    errorCode: null,
  });

  assert.equal(manifest.review_quality.failed_review_slot, true);
});

test("review audit manifest fails completed slots that report read or permission denial", () => {
  const manifest = buildReviewAuditManifest({
    prompt: "rendered prompt",
    sourceFiles: [{ path: "sample.js", text: "export const value = 1;\n" }],
    result: [
      "Verdict: APPROVE",
      "Blocking findings",
      "- No blocking findings claimed because I could not inspect sample.js.",
      "Non-blocking concerns",
      "- Permission denied while reading the selected file.",
      "1. NOT REVIEWED selected file inspection failed",
    ].join("\n"),
    status: "completed",
    errorCode: null,
  });

  assert.equal(manifest.review_quality.failed_review_slot, true);
});

test("review audit manifest accepts concise structured reviews for tiny selected source", () => {
  const result = "1. Verdict: APPROVE.\n"
    + "2. Blocking findings: No blocking findings.\n"
    + "3. Non-blocking concerns: None.\n"
    + "4. Test gaps or verification gaps: None.\n"
    + "5. Inspection state: I explicitly inspected the selected file `README.md`, which contains `# E2E`.";
  const manifest = buildReviewAuditManifest({
    prompt: "rendered prompt",
    sourceFiles: [{ path: "README.md", text: "# E2E\n" }],
    result,
    status: "completed",
    errorCode: null,
  });

  assert.equal(manifest.review_quality.looks_shallow, false);
  assert.equal(manifest.review_quality.failed_review_slot, false);
});

test("review audit manifest fails completed slots that are shallow despite successful transport", () => {
  const manifest = buildReviewAuditManifest({
    prompt: "rendered prompt",
    sourceFiles: [{ path: "sample.js", text: "export const value = 1;\n" }],
    result: "Verdict: APPROVE\nNo blocking findings.",
    status: "completed",
    errorCode: null,
  });

  assert.equal(manifest.review_quality.looks_shallow, true);
  assert.equal(manifest.review_quality.failed_review_slot, true);
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
