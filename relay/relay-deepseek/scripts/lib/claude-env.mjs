// Shared Claude Code host-environment detection.

export function isClaudeCodeHost(env) {
  return env?.CLAUDECODE === "1";
}

export function claudePluginDataRoot(env) {
  const value = env?.CLAUDE_PLUGIN_DATA;
  if (!value) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

export function claudeSessionId(env) {
  const value = env?.CLAUDE_CODE_SESSION_ID;
  if (!value) return null;
  const normalized = String(value).trim();
  return normalized || null;
}
