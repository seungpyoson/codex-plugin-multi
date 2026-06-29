import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/agy/scripts/agy-companion.mjs");
const LIVE_REVIEW_PROMPT = `Live E2E smoke: review README.md as a selected source file.
Return:

1. Verdict: APPROVE or REQUEST CHANGES.
2. Blocking findings first, with file/function evidence. If none, say "No blocking findings."
3. Non-blocking concerns. If none, say "None."
4. Test gaps or verification gaps. If none, say "None."
5. State explicitly whether you inspected the selected file.`;

// #16 follow-up 9: env scrub so a stale GIT_DIR / GIT_WORK_TREE in the
// parent process cannot hijack fixture commits into the caller checkout.
import { fixtureGit, fixtureGitEnv } from "../helpers/fixture-git.mjs";

function seedRepo(cwd) {
  fixtureGit(cwd, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(cwd, "README.md"), "# AGY E2E\n");
  fixtureGit(cwd, ["add", "README.md"]);
  fixtureGit(cwd, ["commit", "-q", "-m", "seed"], {
    env: fixtureGitEnv({
      GIT_AUTHOR_EMAIL: "e2e@example.invalid", GIT_AUTHOR_NAME: "e2e",
      GIT_COMMITTER_EMAIL: "e2e@example.invalid", GIT_COMMITTER_NAME: "e2e",
    }),
  });
  fixtureGit(cwd, ["checkout", "-q", "-b", "agy-e2e-change"]);
  writeFileSync(path.join(cwd, "README.md"), "# AGY E2E\n\nReview this committed branch diff.\n");
  fixtureGit(cwd, ["add", "README.md"]);
  fixtureGit(cwd, ["commit", "-q", "-m", "add review target"], {
    env: fixtureGitEnv({
      GIT_AUTHOR_EMAIL: "e2e@example.invalid", GIT_AUTHOR_NAME: "e2e",
      GIT_COMMITTER_EMAIL: "e2e@example.invalid", GIT_COMMITTER_NAME: "e2e",
    }),
  });
  return {
    headSha: fixtureGit(cwd, ["rev-parse", "HEAD"]).stdout.trim(),
  };
}

test("live AGY foreground review completes", {
  skip: process.env.AGY_LIVE_E2E === "1"
    ? false
    : "Set AGY_LIVE_E2E=1 after authenticating Google Antigravity CLI to run live E2E.",
}, () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "agy-e2e-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "agy-e2e-data-"));
  try {
    const { headSha } = seedRepo(cwd);
    const res = spawnSync("node", [
      COMPANION,
      "run",
      "--mode=review",
      "--foreground",
      "--lifecycle-events", "jsonl",
      "--cwd", cwd,
      "--",
      LIVE_REVIEW_PROMPT,
    ], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        AGY_PLUGIN_DATA: dataDir,
        AGY_BINARY: process.env.AGY_BINARY ?? "agy",
      },
    });

    assert.equal(res.status, 0, [res.stderr, res.stdout].filter(Boolean).join("\n"));
    const records = res.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const terminal = records.at(-1);
    assert.equal(terminal.target, "agy");
    assert.equal(terminal.status, "completed");
    assert.ok(terminal.job_id);

    const resultRes = spawnSync("node", [
      COMPANION,
      "result",
      "--job", terminal.job_id,
      "--cwd", cwd,
    ], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        AGY_PLUGIN_DATA: dataDir,
      },
    });

    assert.equal(resultRes.status, 0, [resultRes.stderr, resultRes.stdout].filter(Boolean).join("\n"));
    const record = JSON.parse(resultRes.stdout);
    assert.equal(record.target, "agy");
    assert.equal(record.status, "completed");
    assert.equal(record.job_id, terminal.job_id);
    assert.ok("result" in record);
    assert.equal(record.scope, "branch-diff");
    assert.equal(record.external_review.source_content_transmission, "sent");
    const audit = record.review_metadata.audit_manifest;
    assert.equal(audit.scope_resolution.scope, "branch-diff");
    assert.equal(audit.scope_resolution.scope_base, null);
    assert.match(audit.scope_resolution.reason, /main\.\.\.HEAD/i);
    assert.match(audit.scope_resolution.reason, /git diff/i);
    assert.equal(audit.git_identity.head_sha, headSha);
    assert.equal(audit.source_content_transmission, "sent");
    assert.equal(audit.selected_source.totals.files, 1);
    assert.deepEqual(audit.selected_source.files.map((file) => file.path), ["README.md"]);
    assert.equal(audit.review_quality.failed_review_slot, false);
    assert.equal(audit.review_quality.looks_shallow, false);
    assert.equal(audit.review_quality.has_verdict, true);
    assert.equal(typeof record.review_metadata.raw_output.elapsed_ms, "number");
  } finally {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
