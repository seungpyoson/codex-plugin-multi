import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildReviewPrompt,
  REVIEW_PROMPT_CHECKLIST,
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
  for (const [name, path] of REVIEW_PROMPT_MODULES.slice(1)) {
    assert.equal(readFileSync(resolve(path), "utf8"), shared, `${name} review-prompt copy drifted`);
  }
});

for (const [name, path] of REVIEW_PROMPT_MODULES) {
  test(`review prompt contract includes exact base/head/scope/checklist metadata (${name})`, async () => {
    const {
      buildReviewPrompt: targetBuildReviewPrompt,
      REVIEW_PROMPT_CHECKLIST: targetChecklist,
    } = await import(pathToFileURL(resolve(path)).href);
    assert.deepEqual(targetChecklist, REVIEW_PROMPT_CHECKLIST);
    assertReviewPromptContract(targetBuildReviewPrompt, targetChecklist);
  });
}

function assertReviewPromptContract(targetBuildReviewPrompt = buildReviewPrompt, targetChecklist = REVIEW_PROMPT_CHECKLIST) {
  const prompt = targetBuildReviewPrompt({
    provider: "Gemini",
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

  assert.match(prompt, /Provider: Gemini/);
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
  assert.match(prompt, /Blocking findings first/);
  assert.match(prompt, /Timed out, truncated, interrupted, blocked, or shallow output is NOT an approval/);
  assert.match(prompt, /User prompt:\nFocus on control-flow bugs\./);
}
