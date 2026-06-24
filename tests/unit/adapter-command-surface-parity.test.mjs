import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readRepoFile(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function functionBlock(source, name) {
  const pattern = new RegExp(`(^|\\n)(?:async\\s+)?function\\s+${escapeRegExp(name)}\\s*\\(`);
  const match = pattern.exec(source);
  assert.ok(match, `missing function ${name}`);
  const index = match.index + (match[1] === "\n" ? 1 : 0);
  const nextFunctionPattern = /\n(?:async\s+)?function\s+[$A-Z_a-z][$\w]*\s*\(/g;
  nextFunctionPattern.lastIndex = index + 1;
  const next = nextFunctionPattern.exec(source);
  const end = next ? next.index : source.length;
  return source.slice(index, end);
}

function commandPolicyBlock(source, name) {
  const block = functionBlock(source, name);
  return /\bcommonRunOptions\s*\(/.test(block)
    ? `${block}\n${functionBlock(source, "commonRunOptions")}`
    : block;
}

function assertContainsAll(haystack, needles, label) {
  for (const needle of needles) {
    assert.match(haystack, new RegExp(escapeRegExp(needle)), `${label}: missing ${needle}`);
  }
}

const SOURCE_PACKET_ROUTE_FIELDS = [
  "providerCapabilities",
  "previousAttempt",
  "resendConfirmationApproved",
  "resumeWithoutSourceResend",
  "sourcePacketOverrideApproved",
  "sourcePacketOverrideSource",
  "reviewSlot",
  "sourceBearing",
  "sourceContentTransmission",
  "sourceSendApprovalState",
];

const RUN_POLICY_FLAGS = [
  "allow-large-source-packet",
  "review-slot-disposition",
  "review-slot-waiver-artifact",
  "review-slot-override-artifact",
];

const CONTINUE_POLICY_FLAGS = [
  "resend-confirmation-approved",
  "allow-large-source-packet",
  "review-slot-disposition",
  "review-slot-waiver-artifact",
  "review-slot-override-artifact",
];

test("companion adapters wire source-packet route fields and command policy flags", () => {
  const adapters = [
    {
      provider: "claude",
      rel: "plugins/claude/scripts/claude-companion.mjs",
      runFunction: "cmdRun",
      continueFunction: "cmdContinue",
      supportsPromptFile: false,
      supportsBackground: true,
      supportsContinue: true,
    },
    {
      provider: "gemini",
      rel: "plugins/gemini/scripts/gemini-companion.mjs",
      runFunction: "cmdRun",
      continueFunction: "cmdContinue",
      supportsPromptFile: true,
      supportsBackground: true,
      supportsContinue: true,
    },
    {
      provider: "kimi",
      rel: "plugins/kimi/scripts/kimi-companion.mjs",
      runFunction: "cmdRun",
      continueFunction: "cmdContinue",
      supportsPromptFile: true,
      supportsBackground: true,
      supportsContinue: true,
    },
    {
      provider: "agy",
      rel: "plugins/agy/scripts/agy-companion.mjs",
      runFunction: "run",
      continueFunction: null,
      supportsPromptFile: true,
      supportsBackground: false,
      supportsContinue: false,
    },
  ];

  for (const adapter of adapters) {
    const source = readRepoFile(adapter.rel);
    assert.match(source, /sourcePacketPolicyPreflight|sourcePacketPolicyFailureFromManifest/, `${adapter.provider}: missing preflight gate`);
    assertContainsAll(source, SOURCE_PACKET_ROUTE_FIELDS, adapter.provider);
    assert.match(source, /latestSourcePacketPreviousAttempt/, `${adapter.provider}: missing prior source attempt collection`);
    assert.match(source, /review_slot_prior_attempts/, `${adapter.provider}: missing review slot prior attempts`);

    const runBlock = commandPolicyBlock(source, adapter.runFunction);
    assertContainsAll(runBlock, RUN_POLICY_FLAGS, `${adapter.provider} run`);
    if (adapter.supportsPromptFile) {
      assertContainsAll(runBlock, ["prompt-file"], `${adapter.provider} run`);
      assert.match(source, /function promptFromOptions/, `${adapter.provider}: --prompt-file must be parsed by shared prompt helper`);
    }
    if (adapter.supportsBackground) {
      assertContainsAll(runBlock, ["background", "foreground"], `${adapter.provider} run`);
    } else {
      assert.match(runBlock, /options\.background[\s\S]*fail\("bad_args"/, `${adapter.provider}: unsupported --background must fail closed`);
    }

    if (adapter.supportsContinue) {
      const continueBlock = commandPolicyBlock(source, adapter.continueFunction);
      assertContainsAll(continueBlock, CONTINUE_POLICY_FLAGS, `${adapter.provider} continue`);
    } else {
      assert.match(source, /command === "continue"[\s\S]*fail\("bad_args"/, `${adapter.provider}: unsupported continue must be explicit`);
    }
  }
});
