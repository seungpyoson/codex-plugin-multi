// Shared companion helper source.
// Edit scripts/lib/companion-common.mjs, then run
// `node scripts/ci/sync-companion-common.mjs` to update plugin packaging copies.

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";

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

const SAFE_JOB_ID = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

function assertSafeSidecarJobId(jobId) {
  if (typeof jobId !== "string" || !SAFE_JOB_ID.test(jobId)) {
    throw new Error(`Unsafe jobId: ${JSON.stringify(jobId)}`);
  }
}

function enforcePrivateMode(target, mode) {
  try {
    chmodSync(target, mode);
  } catch (err) {
    if (process.platform === "win32") return;
    throw err;
  }
  if (process.platform === "win32") return;
  const actual = statSync(target).mode & 0o777;
  if (actual !== mode) {
    throw new Error(`${target} mode ${actual.toString(8)} != ${mode.toString(8)}`);
  }
}

function realpathOrResolve(target) {
  try {
    return realpathSync.native(target);
  } catch {
    return resolvePath(target);
  }
}

function assertRealJobDirectory(jobsDir, dir) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${dir} is not a real directory inside jobsDir`);
  }
  const jobsReal = realpathOrResolve(jobsDir);
  const dirReal = realpathOrResolve(dir);
  const jobsPrefix = jobsReal.endsWith(sep) ? jobsReal : `${jobsReal}${sep}`;
  if (!dirReal.startsWith(jobsPrefix)) {
    throw new Error(`${dir} is not a real directory inside jobsDir`);
  }
}

export function promptSidecarPath(jobsDir, jobId) {
  assertSafeSidecarJobId(jobId);
  return resolvePath(jobsDir, jobId, "prompt.txt");
}

export function writePromptSidecar(jobsDir, jobId, prompt) {
  assertSafeSidecarJobId(jobId);
  const dir = resolvePath(jobsDir, jobId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertRealJobDirectory(jobsDir, dir);
  enforcePrivateMode(dir, 0o700);
  const p = promptSidecarPath(jobsDir, jobId);
  const tmpFile = `${p}.${process.pid}.${Date.now()}.tmp`;
  let renamed = false;
  try {
    writeFileSync(tmpFile, prompt, { mode: 0o600, encoding: "utf8" });
    enforcePrivateMode(tmpFile, 0o600);
    renameSync(tmpFile, p);
    renamed = true;
    enforcePrivateMode(p, 0o600);
  } catch (err) {
    try { unlinkSync(renamed ? p : tmpFile); } catch { /* already gone */ }
    throw err;
  }
}

export function consumePromptSidecar(jobsDir, jobId) {
  assertSafeSidecarJobId(jobId);
  const p = promptSidecarPath(jobsDir, jobId);
  let prompt;
  try {
    prompt = readFileSync(p, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
    throw err;
  }
  try {
    unlinkSync(p);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
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
