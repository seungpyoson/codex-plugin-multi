import { test } from "node:test";
import assert from "node:assert/strict";

import {
  claudePluginDataRoot,
  claudeSessionId,
  isClaudeCodeHost,
} from "../../scripts/lib/claude-env.mjs";

test("isClaudeCodeHost: treats CLAUDECODE=1 as the Claude Code host signal", () => {
  assert.equal(isClaudeCodeHost({ CLAUDECODE: "1" }), true);
  assert.equal(isClaudeCodeHost({ CLAUDECODE: "true" }), false);
  assert.equal(isClaudeCodeHost({ CLAUDECODE: "0" }), false);
  assert.equal(isClaudeCodeHost({}), false);
  assert.equal(isClaudeCodeHost(null), false);
});

test("claudePluginDataRoot: uses CLAUDE_PLUGIN_DATA only when non-empty", () => {
  assert.equal(claudePluginDataRoot({ CLAUDE_PLUGIN_DATA: "/tmp/relay-data" }), "/tmp/relay-data");
  assert.equal(claudePluginDataRoot({ CLAUDE_PLUGIN_DATA: "  /tmp/spaced  " }), "/tmp/spaced");
  assert.equal(claudePluginDataRoot({ CLAUDE_PLUGIN_DATA: "" }), null);
  assert.equal(claudePluginDataRoot({}), null);
});

test("claudeSessionId: maps Claude Code session id without inventing fallback ids", () => {
  assert.equal(claudeSessionId({ CLAUDE_CODE_SESSION_ID: "session-123" }), "session-123");
  assert.equal(claudeSessionId({ CLAUDE_CODE_SESSION_ID: "  session-456  " }), "session-456");
  assert.equal(claudeSessionId({ CLAUDE_CODE_SESSION_ID: "" }), null);
  assert.equal(claudeSessionId({}), null);
});
