import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureSeedRepo } from "../helpers/fixture-git.mjs";
import { buildJobRecord as buildClaudeJobRecord } from "../../plugins/claude/scripts/lib/job-record.mjs";
import {
  writeJobFile as writeClaudeJobFile,
  upsertJob as upsertClaudeJob,
} from "../../plugins/claude/scripts/lib/state.mjs";
import { buildJobRecord as buildGeminiJobRecord } from "../../plugins/gemini/scripts/lib/job-record.mjs";
import {
  writeJobFile as writeGeminiJobFile,
  upsertJob as upsertGeminiJob,
} from "../../plugins/gemini/scripts/lib/state.mjs";
import { buildJobRecord as buildKimiJobRecord } from "../../plugins/kimi/scripts/lib/job-record.mjs";
import {
  writeJobFile as writeKimiJobFile,
  upsertJob as upsertKimiJob,
} from "../../plugins/kimi/scripts/lib/state.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function oldStartedAt() {
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
}

const PROVIDERS = [
  {
    name: "Claude",
    target: "claude",
    providerName: "Claude Code",
    companion: "plugins/claude/scripts/claude-companion.mjs",
    dataEnv: "CLAUDE_PLUGIN_DATA",
    binaryEnv: "CLAUDE_BINARY",
    binary: "claude",
    mock: "tests/smoke/claude-mock.mjs",
    build: buildClaudeJobRecord,
    writeJobFile: writeClaudeJobFile,
    upsertJob: upsertClaudeJob,
  },
  {
    name: "Gemini",
    target: "gemini",
    providerName: "Gemini CLI",
    companion: "plugins/gemini/scripts/gemini-companion.mjs",
    dataEnv: "GEMINI_PLUGIN_DATA",
    binaryEnv: "GEMINI_BINARY",
    binary: "gemini",
    mock: "tests/smoke/gemini-mock.mjs",
    build: buildGeminiJobRecord,
    writeJobFile: writeGeminiJobFile,
    upsertJob: upsertGeminiJob,
  },
  {
    name: "Kimi",
    target: "kimi",
    providerName: "Kimi Code CLI",
    companion: "plugins/kimi/scripts/kimi-companion.mjs",
    dataEnv: "KIMI_PLUGIN_DATA",
    binaryEnv: "KIMI_BINARY",
    binary: "kimi",
    mock: "tests/smoke/kimi-mock.mjs",
    build: buildKimiJobRecord,
    writeJobFile: writeKimiJobFile,
    upsertJob: upsertKimiJob,
  },
];

const RECONCILE_AUDIT_MANIFEST = Object.freeze({
  schema_version: 1,
  rendered_prompt_hash: Object.freeze({
    algorithm: "sha256",
    value: "b".repeat(64),
  }),
  selected_source: Object.freeze({
    files: Object.freeze([
      Object.freeze({
        path: "seed.txt",
        bytes: 21,
        lines: 1,
        content_hash: Object.freeze({
          algorithm: "sha256",
          value: "c".repeat(64),
        }),
      }),
    ]),
    totals: Object.freeze({
      files: 1,
      bytes: 21,
      lines: 1,
    }),
  }),
  request: Object.freeze({
    timeout_ms: 900000,
  }),
  selected_route: "subscription_oauth",
  auth_path: "subscription_oauth",
  billing_path: null,
  source_send_approval_state: "not_required",
  source_send_approval_required: false,
  review_quality: Object.freeze({
    has_verdict: false,
    has_blocking_section: false,
    has_non_blocking_section: false,
    checklist_items_seen: 0,
    looks_shallow: false,
    semantic_failure_reasons: Object.freeze([]),
    failed_review_slot: false,
  }),
});

for (const provider of PROVIDERS) {
  test(`${provider.name} result --job reconciles orphaned active jobs before reading meta`, () => {
    const cwd = mkdtempSync(path.join(tmpdir(), `${provider.target}-result-reconcile-cwd-`));
    const dataDir = mkdtempSync(path.join(tmpdir(), `${provider.target}-result-reconcile-data-`));
    const jobId = `job_${randomUUID()}`;
    const priorDataEnv = process.env[provider.dataEnv];
    try {
      fixtureSeedRepo(cwd);
      process.env[provider.dataEnv] = dataDir;
      const record = provider.build({
        job_id: jobId,
        target: provider.target,
        parent_job_id: null,
        resume_chain: [],
        mode_profile_name: "review",
        mode: "review",
        model: "test-model",
        cwd,
        workspace_root: cwd,
        containment: "worktree",
        scope: "working-tree",
        run_kind: "background",
        dispose_effective: false,
        scope_base: null,
        scope_paths: null,
        prompt_head: "seed",
        review_prompt_contract_version: 1,
        review_prompt_provider: provider.providerName,
        schema_spec: null,
        binary: provider.binary,
        started_at: oldStartedAt(),
      }, {
        status: "running",
        exitCode: null,
        signal: null,
        timedOut: false,
        parsed: null,
        pidInfo: null,
        claudeSessionId: "claude-session-for-reconcile",
        geminiSessionId: "gemini-session-for-reconcile",
        kimiSessionId: "kimi-session-for-reconcile",
      }, []);
      const recordWithAudit = {
        ...record,
        review_metadata: {
          ...record.review_metadata,
          audit_manifest: RECONCILE_AUDIT_MANIFEST,
        },
      };
      provider.writeJobFile(cwd, jobId, recordWithAudit);
      provider.upsertJob(cwd, recordWithAudit);

      const result = spawnSync("node", [
        path.join(REPO_ROOT, provider.companion),
        "result",
        "--job",
        jobId,
        "--cwd",
        cwd,
      ], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          [provider.dataEnv]: dataDir,
          [provider.binaryEnv]: path.join(REPO_ROOT, provider.mock),
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const meta = JSON.parse(result.stdout);
      assert.equal(meta.id, jobId);
      assert.equal(meta.status, "stale");
      assert.equal(meta.error_code, "stale_active_job");
      assert.equal(meta.claude_session_id, "claude-session-for-reconcile");
      assert.equal(meta.gemini_session_id, "gemini-session-for-reconcile");
      assert.equal(meta.kimi_session_id, "kimi-session-for-reconcile");
      assert.equal(meta.review_metadata.audit_manifest.rendered_prompt_hash.value, "b".repeat(64));
      assert.equal(meta.review_metadata.audit_manifest.selected_source.totals.files, 1);
      assert.equal(meta.review_metadata.audit_manifest.selected_route, "subscription_oauth");
      assert.equal(meta.review_metadata.audit_manifest.auth_path, "subscription_oauth");
      assert.equal(meta.review_metadata.audit_manifest.source_send_approval_state, "not_required");
      assert.match(meta.error_message, /missing pid_info|never produced pid_info/);
    } finally {
      if (priorDataEnv === undefined) {
        delete process.env[provider.dataEnv];
      } else {
        process.env[provider.dataEnv] = priorDataEnv;
      }
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
