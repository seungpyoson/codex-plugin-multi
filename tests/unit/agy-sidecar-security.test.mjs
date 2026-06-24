import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/agy/scripts/agy-companion.mjs");

function functionBody(source, name) {
  const signature = source.match(new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`));
  assert.ok(signature, `missing function ${name}`);
  const bodyStart = signature.index + signature[0].length;
  let depth = 1;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(bodyStart, index);
  }
  assert.fail(`unterminated function ${name}`);
}

test("AGY sidecar writers use shared job-id and real-directory validation", () => {
  const source = readFileSync(COMPANION, "utf8");

  assert.match(
    source,
    /runtimeOptionsSidecarPath as commonRuntimeOptionsSidecarPath/,
    "AGY must import the shared runtime-options sidecar path helper",
  );
  assert.match(
    source,
    /assertRealJobDirectory/,
    "AGY must import the shared real job-directory assertion",
  );
  assert.match(
    readFileSync(path.join(REPO_ROOT, "scripts/lib/companion-common.mjs"), "utf8"),
    /export function assertRealJobDirectory/,
    "the shared real job-directory assertion must be exported instead of reimplemented locally",
  );

  assert.match(
    functionBody(source, "runtimeOptionsSidecarPath"),
    /commonRuntimeOptionsSidecarPath\(resolveJobsDir\(workspaceRoot\),\s*jobId\)/,
    "AGY runtime options sidecars must validate jobId through companion-common",
  );
  assert.match(
    functionBody(source, "prepareSidecarJobDirectory"),
    /assertRealJobDirectory\(jobsDirectory,\s*dir\)/,
    "AGY sidecar writers must reject symlink or escaped job directories before writing",
  );
  assert.match(
    functionBody(source, "agySidecarPath"),
    /AGY_WRITABLE_SIDECARS\.has\(name\)/,
    "AGY sidecar writers must allow only internal sidecar filenames",
  );
  assert.match(
    functionBody(source, "writeSidecar"),
    /agySidecarPath\(workspaceRoot,\s*jobId,\s*name\)/,
    "AGY generic sidecar writes must pass through the filename allowlist",
  );
  assert.doesNotMatch(
    functionBody(source, "writeSidecar"),
    /\$\{dir\}\/\$\{name\}/,
    "AGY must not rebuild arbitrary sidecar paths from unchecked names",
  );
});
