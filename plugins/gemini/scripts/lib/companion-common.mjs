// Shared companion helper source.
// Edit scripts/lib/companion-common.mjs, then run
// `node scripts/ci/sync-companion-common.mjs` to update plugin packaging copies.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

export const PING_PROMPT =
  "reply with exactly: pong. Do not use any tools, do not read files, and do not explore the workspace.";

export function printJson(obj, output = process.stdout) {
  output.write(`${JSON.stringify(obj, null, 2)}\n`);
}

export function parseScopePathsOption(value) {
  return value
    ? String(value).split(",").map((s) => s.trim()).filter(Boolean)
    : null;
}

export function comparePathStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function summarizeScopeDirectory(root) {
  const files = [];
  let byteCount = 0;
  function walk(absDir, relDir = "") {
    for (const ent of readdirSync(absDir, { withFileTypes: true })) {
      const abs = resolvePath(absDir, ent.name);
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!ent.isFile()) continue;
      files.push(rel);
      byteCount += statSync(abs).size;
    }
  }
  if (existsSync(root)) walk(root);
  files.sort(comparePathStrings);
  return { files, file_count: files.length, byte_count: byteCount };
}

export function gitStatusLines(output) {
  return output.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
}

export function runKindFromRecord(record) {
  if (record.external_review?.run_kind) return record.external_review.run_kind;
  return "unknown";
}

export function promptSidecarPath(jobsDir, jobId) {
  return resolvePath(jobsDir, jobId, "prompt.txt");
}

export function writePromptSidecar(jobsDir, jobId, prompt) {
  const dir = resolvePath(jobsDir, jobId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best-effort on non-POSIX */ }
  const p = promptSidecarPath(jobsDir, jobId);
  writeFileSync(p, prompt, { mode: 0o600, encoding: "utf8" });
  try { chmodSync(p, 0o600); } catch { /* best-effort on non-POSIX */ }
}

export function consumePromptSidecar(jobsDir, jobId) {
  const p = promptSidecarPath(jobsDir, jobId);
  let prompt;
  try {
    prompt = readFileSync(p, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  try { unlinkSync(p); } catch { /* already gone */ }
  return prompt;
}

export function preflightDisclosure(target) {
  return (
    `Preflight only: ${target} was not spawned, and no selected scope content ` +
    "was sent to the target CLI or external provider. A later successful " +
    `external review still sends the selected files to ${target}.`
  );
}

export function preflightSafetyFields() {
  return {
    target_spawned: false,
    selected_scope_sent_to_provider: false,
    requires_external_provider_consent: true,
  };
}

export function credentialNameDiagnostics(providerApiKeyEnv, env = process.env) {
  const ignored = providerApiKeyEnv.filter((key) => env[key]);
  if (ignored.length === 0) return {};
  return {
    ignored_env_credentials: ignored,
    auth_policy: "api_key_env_ignored",
  };
}
