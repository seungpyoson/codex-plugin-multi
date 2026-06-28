import assert from "node:assert/strict";

const CODEX_SANDBOX_REPAIR_GUIDANCE_RE =
  /\bCodex\b|~\/\.codex\/config\.toml|\[sandbox_workspace_write\]|sandbox_permissions|require_escalated|writable_roots/;

export function assertNoCodexSandboxRepairGuidance(value, label = "diagnostic") {
  assert.doesNotMatch(
    String(value ?? ""),
    CODEX_SANDBOX_REPAIR_GUIDANCE_RE,
    `${label} must not contain Codex-specific sandbox repair guidance`,
  );
}

export function assertHostNeutralSandboxSummary(value, label = "sandbox summary") {
  const text = String(value ?? "");
  assert.match(text, /host sandbox/i, `${label} must describe the host sandbox`);
  assertNoCodexSandboxRepairGuidance(text, label);
}

export function assertHostNeutralSandboxRepairAction(
  value,
  { statePathPattern = null, label = "sandbox repair action" } = {},
) {
  const text = String(value ?? "");
  assert.match(text, /writable roots?/i, `${label} must mention writable roots`);
  assert.match(
    text,
    /current host sandbox|fresh host session/i,
    `${label} must describe host-neutral sandbox repair`,
  );
  if (statePathPattern) {
    assert.match(text, statePathPattern, `${label} must identify the provider state path`);
  }
  assertNoCodexSandboxRepairGuidance(text, label);
}
