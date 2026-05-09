import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO_ROOT, "plugins/grok/scripts/grok-web-reviewer.mjs");
const LIVE_REVIEW_PROMPT = `Live E2E smoke: review README.md as a selected source file.
Return:

1. Verdict: APPROVE or REQUEST CHANGES.
2. Blocking findings first, with file/function evidence. If none, say "No blocking findings."
3. Non-blocking concerns. If none, say "None."
4. Test gaps or verification gaps. If none, say "None."
5. State explicitly whether you inspected the selected file.`;

function runGrok(args, options = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      ...options.env,
    },
  });
}

function parseJson(result) {
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

test("live Grok subscription-backed local tunnel custom review completes", {
  skip: process.env.GROK_LIVE_E2E === "1"
    ? false
    : "Set GROK_LIVE_E2E=1 after starting a subscription-backed Grok web tunnel to run live E2E.",
}, () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "grok-e2e-cwd-"));
  const dataDir = mkdtempSync(path.join(tmpdir(), "grok-e2e-data-"));
  try {
    writeFileSync(path.join(cwd, "README.md"), "# Grok E2E\n\nSubscription-backed tunnel smoke.\n");

    const doctor = runGrok(["doctor"], {
      cwd,
      env: { GROK_PLUGIN_DATA: dataDir },
    });
    assert.equal(doctor.status, 0, [doctor.stderr, doctor.stdout].filter(Boolean).join("\n"));
    const readiness = parseJson(doctor);
    assert.equal(readiness.provider, "grok-web");
    assert.equal(readiness.auth_mode, "subscription_web");
    assert.equal(readiness.ready, true, readiness.error_message ?? readiness.next_action);
    assert.equal(readiness.reachable, true, readiness.error_message ?? readiness.next_action);
    assert.doesNotMatch(doctor.stdout, /api\.x\.ai/i);

    const review = runGrok([
      "run",
      "--mode", "custom-review",
      "--scope", "custom",
      "--scope-paths", "README.md",
      "--foreground",
      "--prompt", LIVE_REVIEW_PROMPT,
    ], {
      cwd,
      env: { GROK_PLUGIN_DATA: dataDir },
    });

    assert.equal(review.status, 0, [review.stderr, review.stdout].filter(Boolean).join("\n"));
    const record = parseJson(review);
    assert.equal(record.target, "grok-web");
    assert.equal(record.provider, "grok-web");
    assert.equal(record.auth_mode, "subscription_web");
    assert.equal(record.status, "completed");
    assert.equal(record.external_review.source_content_transmission, "sent");
    assert.ok(record.job_id);
    assert.ok(record.result);
    assert.equal(record.review_metadata.audit_manifest.review_quality.failed_review_slot, false);
    assert.equal(record.review_metadata.audit_manifest.review_quality.looks_shallow, false);
    assert.equal(record.review_metadata.audit_manifest.review_quality.has_verdict, true);
    assert.equal(typeof record.review_metadata.raw_output.elapsed_ms, "number");
    assert.doesNotMatch(review.stdout, /api\.x\.ai/i);
  } finally {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
