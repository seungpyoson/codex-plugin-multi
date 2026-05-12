import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  buildReviewPanelRows,
  collectReviewPanelRecords,
  renderReviewPanelMarkdown,
} from "../../scripts/lib/review-panel.mjs";

test("review panel slug trimming avoids Sonar-flagged boundary alternation regex", () => {
  const source = readFileSync(new URL("../../scripts/lib/review-panel.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /value\.replace\(\s*\/\^-\+\|-\+\$\/g/);
});

test("review panel rows expose operational and semantic review state", () => {
  const rows = buildReviewPanelRows([
    {
      target: "claude",
      status: "failed",
      error_code: "review_not_completed",
      http_status: null,
      external_review: {
        source_content_transmission: "sent",
      },
      review_metadata: {
        raw_output: {
          elapsed_ms: 337917,
        },
        audit_manifest: {
          review_quality: {
            failed_review_slot: true,
            semantic_failure_reasons: ["permission_blocked", "not_reviewed"],
          },
        },
      },
      runtime_diagnostics: {
        permission_denials: [
          {
            path: "/private/tmp/cpm-abtest/packet2_security/gate.js",
          },
        ],
      },
    },
    {
      target: "grok",
      status: "failed",
      error_code: "models_ok_chat_400",
      http_status: 400,
      external_review: {
        source_content_transmission: "not_sent",
      },
      review_metadata: {
        raw_output: {
          elapsed_ms: 554,
        },
        audit_manifest: {
          review_quality: {
            failed_review_slot: true,
            semantic_failure_reasons: ["provider_unavailable"],
          },
        },
      },
    },
    {
      provider: "glm",
      status: "completed",
      http_status: 200,
      external_review: {
        source_content_transmission: "sent",
      },
      review_metadata: {
        raw_output: {
          elapsed_ms: 45422,
        },
        audit_manifest: {
          review_quality: {
            failed_review_slot: false,
            semantic_failure_reasons: [],
          },
        },
      },
      result: "Verdict: REQUEST CHANGES\nInspection status\n- I inspected the selected files.",
    },
  ]);

  assert.deepEqual(rows, [
    {
      provider: "claude",
      job_id: "",
      state: "failed",
      status: "failed",
      readiness: "review failed",
      sent: "sent",
      source_sent: "sent",
      elapsed_ms: 337917,
      timeout_ms: "",
      result: "review_not_completed",
      semantic_failed: true,
      inspection: "blocked",
      error_code: "review_not_completed",
      http_status: "",
      reasons: "permission_blocked,not_reviewed",
    },
    {
      provider: "grok",
      job_id: "",
      state: "failed_before_source_send",
      status: "failed",
      readiness: "not review-ready",
      sent: "not_sent",
      source_sent: "not_sent",
      elapsed_ms: 554,
      timeout_ms: "",
      result: "models_ok_chat_400",
      semantic_failed: true,
      inspection: "unknown",
      error_code: "models_ok_chat_400",
      http_status: 400,
      reasons: "provider_unavailable",
    },
    {
      provider: "glm",
      job_id: "",
      state: "completed",
      status: "completed",
      readiness: "review-ready",
      sent: "sent",
      source_sent: "sent",
      elapsed_ms: 45422,
      timeout_ms: "",
      result: "request_changes",
      semantic_failed: false,
      inspection: "inspected",
      error_code: "",
      http_status: 200,
      reasons: "",
    },
  ]);
});

test("review panel markdown renders one visibly explicit provider row per record", () => {
  const markdown = renderReviewPanelMarkdown([
    {
      target: "claude",
      status: "failed",
      error_code: "review_not_completed",
      external_review: { source_content_transmission: "sent" },
      review_metadata: {
        raw_output: { elapsed_ms: 70906 },
        audit_manifest: {
          review_quality: {
            failed_review_slot: true,
            semantic_failure_reasons: ["not_reviewed"],
          },
        },
      },
      result: "NOT REVIEWED: could not inspect the selected files.",
    },
  ]);

  assert.match(markdown, /Provider \| Job ID \| State \| Sent \| Elapsed/);
  assert.match(markdown, /claude \|  \| failed \| sent \| 70906/);
  assert.match(markdown, /review_not_completed/);
  assert.match(markdown, /not_reviewed/);
});

test("review panel does not call NOT REVIEWED a permission block without read-denial evidence", () => {
  const [row] = buildReviewPanelRows([
    {
      target: "claude",
      status: "failed",
      error_code: "review_not_completed",
      external_review: { source_content_transmission: "sent" },
      review_metadata: {
        raw_output: { elapsed_ms: 1200 },
        audit_manifest: {
          review_quality: {
            failed_review_slot: true,
            semantic_failure_reasons: ["not_reviewed"],
          },
        },
      },
      result: "NOT REVIEWED: no substantive review was produced.",
    },
  ]);

  assert.equal(row.inspection, "unknown");
  assert.equal(row.reasons, "not_reviewed");
});

test("review panel CLI renders markdown from a JSON array file", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-panel-"));
  const file = join(dir, "records.json");
  writeFileSync(file, JSON.stringify([
    {
      target: "deepseek",
      status: "completed",
      http_status: 200,
      external_review: { source_content_transmission: "sent" },
      review_metadata: {
        raw_output: { elapsed_ms: 44211 },
        audit_manifest: {
          review_quality: {
            failed_review_slot: false,
            semantic_failure_reasons: [],
          },
        },
      },
      result: "Verdict: REQUEST CHANGES\nInspection status\n- I inspected the selected file.",
    },
  ]));

  const output = execFileSync(process.execPath, ["scripts/review-panel.mjs", file], {
    cwd: new URL("../..", import.meta.url),
    encoding: "utf8",
  });

  assert.match(output, /deepseek \|  \| completed \| sent \| 44211/);
});

test("review panel CLI rejects workspace and file arguments together", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-panel-"));
  const file = join(dir, "records.json");
  writeFileSync(file, JSON.stringify([]));

  const res = spawnSync(process.execPath, [
    "scripts/review-panel.mjs",
    "--workspace", dir,
    file,
  ], {
    cwd: new URL("../..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(res.status, 1);
  assert.equal(res.stdout, "");
  assert.match(res.stderr, /--workspace and a file argument are mutually exclusive/);
});

test("review panel CLI accepts workspace paths that start with dashes", () => {
  const parent = mkdtempSync(join(tmpdir(), "review-panel-dash-parent-"));
  const workspace = join(parent, "--staging");
  mkdirSync(workspace);

  const res = spawnSync(process.execPath, [
    resolve("scripts/review-panel.mjs"),
    "--workspace", "--staging",
  ], {
    cwd: parent,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-claude-")),
      GEMINI_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-gemini-")),
      KIMI_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-kimi-")),
      GROK_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-grok-")),
      API_REVIEWERS_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-api-")),
    },
  });

  assert.equal(res.status, 0);
  assert.match(res.stdout, /Provider \| Job ID \| State/);
});

test("review panel treats queued jobs as active even with stale approval error code", () => {
  const [row] = buildReviewPanelRows([
    {
      provider: "deepseek",
      status: "queued",
      error_code: "approval_required",
      external_review: { source_content_transmission: "not_sent" },
    },
  ]);

  assert.equal(row.state, "running");
  assert.equal(row.result, "-");
});

test("review panel does not show stale failed-review-slot result for active jobs", () => {
  const [row] = buildReviewPanelRows([
    {
      provider: "claude",
      status: "running",
      external_review: { source_content_transmission: "sent" },
      review_metadata: {
        audit_manifest: {
          review_quality: {
            failed_review_slot: true,
            semantic_failure_reasons: ["missing_verdict"],
          },
        },
      },
    },
  ]);

  assert.equal(row.state, "source_sent_waiting");
  assert.equal(row.result, "-");
  assert.equal(row.semantic_failed, false);
  assert.equal(row.reasons, "");
});

test("review panel prioritizes failed error codes over stale failed-review-slot metadata", () => {
  const [row] = buildReviewPanelRows([
    {
      provider: "gemini",
      status: "failed",
      error_code: "timeout",
      external_review: { source_content_transmission: "sent" },
      review_metadata: {
        audit_manifest: {
          review_quality: {
            failed_review_slot: true,
            semantic_failure_reasons: ["missing_verdict"],
          },
        },
      },
    },
  ]);

  assert.equal(row.state, "source_sent_timeout");
  assert.equal(row.result, "timeout");
});

test("review panel distinguishes transient rate limits from quota exhaustion", () => {
  const rows = buildReviewPanelRows([
    {
      provider: "deepseek",
      status: "failed",
      error_code: "rate_limited",
      external_review: { source_content_transmission: "not_sent" },
    },
    {
      provider: "glm",
      status: "failed",
      error_code: "usage_limited",
      external_review: { source_content_transmission: "not_sent" },
    },
    {
      provider: "grok",
      status: "failed",
      error_code: "tunnel_unavailable",
      external_review: { source_content_transmission: "not_sent" },
    },
    {
      provider: "claude",
      status: "failed",
      error_code: "session_expired",
      external_review: { source_content_transmission: "not_sent" },
    },
  ]);

  assert.equal(rows[0].state, "rate_limited");
  assert.equal(rows[1].state, "usage_limited");
  assert.equal(rows[2].state, "provider_unavailable");
  assert.equal(rows[3].state, "auth_session_failure");
});

function writeRecord(root, record, stateSubdir = null) {
  const jobId = record.job_id ?? record.id;
  const dir = stateSubdir
    ? join(root, "state", stateSubdir, "jobs", jobId)
    : join(root, "jobs", jobId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify(record, null, 2));
}

function writeCompanionRecord(root, record, stateSubdir) {
  const jobId = record.job_id ?? record.id;
  const dir = join(root, "state", stateSubdir, "jobs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${jobId}.json`), JSON.stringify(record, null, 2));
}

function writerDefaultDataRoot(pluginName, cwd) {
  const workspace = resolve(cwd);
  const slug = basename(workspace).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48) || "workspace";
  const hash = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  return resolve(tmpdir(), "codex-plugin-multi", pluginName, `${slug}-${hash}`);
}

function companionStateIdForWorkspaceRoot(workspaceRoot) {
  const canonical = realpathSync.native(resolve(workspaceRoot));
  const slug = (basename(workspaceRoot) || "workspace").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}

test("review panel CLI aggregates live and recent jobs across provider state roots", () => {
  const workspace = mkdtempSync(join(tmpdir(), "review-panel-workspace-"));
  const claudeData = mkdtempSync(join(tmpdir(), "review-panel-claude-"));
  const geminiData = mkdtempSync(join(tmpdir(), "review-panel-gemini-"));
  const kimiData = mkdtempSync(join(tmpdir(), "review-panel-kimi-"));
  const grokData = mkdtempSync(join(tmpdir(), "review-panel-grok-"));
  const apiData = mkdtempSync(join(tmpdir(), "review-panel-api-"));

  writeCompanionRecord(claudeData, {
    job_id: "job_11111111-1111-4111-8111-111111111111",
    provider: "claude",
    status: "running",
    workspace_root: workspace,
    external_review: { source_content_transmission: "sent" },
    review_metadata: { raw_output: { elapsed_ms: 1234 } },
  }, "workspace-a");

  writeCompanionRecord(geminiData, {
    job_id: "job_22222222-2222-4222-8222-222222222222",
    provider: "gemini",
    status: "failed",
    error_code: "timeout",
    workspace_root: workspace,
    external_review: { source_content_transmission: "sent" },
    review_metadata: { raw_output: { elapsed_ms: 600000 } },
  }, "workspace-a");

  writeRecord(grokData, {
    job_id: "job_33333333-3333-4333-8333-333333333333",
    provider: "grok",
    status: "failed",
    error_code: "tunnel_unavailable",
    workspace_root: workspace,
    external_review: { source_content_transmission: "not_sent" },
    review_metadata: { raw_output: { elapsed_ms: 8000 } },
  });

  writeCompanionRecord(kimiData, {
    job_id: "job_66666666-6666-4666-8666-666666666666",
    provider: "kimi",
    status: "failed",
    error_code: "provider_unavailable",
    workspace_root: workspace,
    external_review: { source_content_transmission: "sent" },
    review_metadata: { raw_output: { elapsed_ms: 99 } },
  }, "workspace-a");

  writeRecord(apiData, {
    id: "job_44444444-4444-4444-8444-444444444444",
    job_id: "job_44444444-4444-4444-8444-444444444444",
    provider: "deepseek",
    status: "failed",
    error_code: "approval_required",
    workspace_root: workspace,
    external_review: { source_content_transmission: "not_sent" },
    review_metadata: { raw_output: { elapsed_ms: 34 } },
  });

  writeRecord(apiData, {
    id: "job_55555555-5555-4555-8555-555555555555",
    job_id: "job_55555555-5555-4555-8555-555555555555",
    provider: "glm",
    status: "completed",
    http_status: 200,
    workspace_root: workspace,
    external_review: { source_content_transmission: "sent" },
    review_metadata: {
      raw_output: { elapsed_ms: 45422 },
      audit_manifest: { review_quality: { failed_review_slot: false, semantic_failure_reasons: [] } },
    },
    result: "Verdict: APPROVE\nInspection status\n- I inspected the selected file.",
  });

  writeRecord(apiData, {
    id: "job_77777777-7777-4777-8777-777777777777",
    job_id: "job_77777777-7777-4777-8777-777777777777",
    provider: "glm",
    status: "completed",
    workspace_root: workspace,
    external_review: { source_content_transmission: "sent" },
    review_metadata: {
      raw_output: { elapsed_ms: 91 },
      audit_manifest: {
        review_quality: {
          failed_review_slot: true,
          semantic_failure_reasons: ["shallow_output", "missing_verdict"],
        },
      },
    },
    result: "No actionable review.",
  });

  const output = execFileSync(process.execPath, [
    "scripts/review-panel.mjs",
    "--workspace", workspace,
  ], {
    cwd: new URL("../..", import.meta.url),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: claudeData,
      GEMINI_PLUGIN_DATA: geminiData,
      KIMI_PLUGIN_DATA: kimiData,
      GROK_PLUGIN_DATA: grokData,
      API_REVIEWERS_PLUGIN_DATA: apiData,
    },
  });

  assert.match(output, /Provider \| Job ID \| State \| Sent \| Elapsed ms \| Timeout ms \| Result/);
  assert.match(output, /claude \| job_11111111-1111-4111-8111-111111111111 \| source_sent_waiting \| sent \| 1234 \|  \| -/);
  assert.match(output, /gemini \| job_22222222-2222-4222-8222-222222222222 \| source_sent_timeout \| sent \| 600000 \|  \| timeout/);
  assert.match(output, /kimi \| job_66666666-6666-4666-8666-666666666666 \| provider_unavailable \| sent \| 99 \|  \| provider_unavailable/);
  assert.match(output, /grok \| job_33333333-3333-4333-8333-333333333333 \| provider_unavailable \| not_sent \| 8000 \|  \| tunnel_unavailable/);
  assert.match(output, /deepseek \| job_44444444-4444-4444-8444-444444444444 \| approval_required \| not_sent \| 34 \|  \| approval_required/);
  assert.match(output, /glm \| job_55555555-5555-4555-8555-555555555555 \| completed \| sent \| 45422 \|  \| approve/);
  assert.match(output, /glm \| job_77777777-7777-4777-8777-777777777777 \| completed_failed_review_slot \| sent \| 91 \|  \| failed_review_slot/);
});

test("review panel workspace collection excludes records without workspace metadata from scanned state roots", () => {
  const workspace = mkdtempSync(join(tmpdir(), "review-panel-workspace-"));
  const otherWorkspace = mkdtempSync(join(tmpdir(), "review-panel-other-"));
  const claudeData = mkdtempSync(join(tmpdir(), "review-panel-claude-"));

  writeRecord(claudeData, {
    job_id: "job_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    provider: "claude",
    status: "completed",
    workspace_root: workspace,
    result: "Verdict: APPROVE",
  }, "workspace-a");

  writeRecord(claudeData, {
    job_id: "job_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    provider: "claude",
    status: "completed",
    result: "Verdict: APPROVE",
  }, "other-workspace-without-metadata");

  writeRecord(claudeData, {
    job_id: "job_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    provider: "claude",
    status: "completed",
    workspace_root: otherWorkspace,
    result: "Verdict: APPROVE",
  }, "other-workspace");

  const records = collectReviewPanelRecords({
    cwd: workspace,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: claudeData,
      GEMINI_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-gemini-")),
      KIMI_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-kimi-")),
      GROK_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-grok-")),
      API_REVIEWERS_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-api-")),
    },
  });

  assert.deepEqual(records.map((record) => record.job_id), [
    "job_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ]);
});

test("review panel skips malformed workspace metadata without aborting collection", () => {
  const workspace = mkdtempSync(join(tmpdir(), "review-panel-workspace-"));
  const claudeData = mkdtempSync(join(tmpdir(), "review-panel-claude-"));

  writeRecord(claudeData, {
    job_id: "job_valid-0000-4000-8000-000000000000",
    provider: "claude",
    status: "completed",
    workspace_root: workspace,
    result: "Verdict: APPROVE",
  }, "workspace-a");

  writeRecord(claudeData, {
    job_id: "job_bad-0000-4000-8000-000000000000",
    provider: "claude",
    status: "completed",
    workspace_root: [workspace],
    result: "Verdict: APPROVE",
  }, "workspace-a");

  const records = collectReviewPanelRecords({
    cwd: workspace,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: claudeData,
      GEMINI_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-gemini-")),
      KIMI_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-kimi-")),
      GROK_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-grok-")),
      API_REVIEWERS_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-api-")),
    },
  });

  assert.deepEqual(records.map((record) => record.job_id), [
    "job_valid-0000-4000-8000-000000000000",
  ]);
});

test("review panel rejects filesystem-root workspace records", () => {
  const workspace = mkdtempSync(join(tmpdir(), "review-panel-workspace-"));
  const apiData = mkdtempSync(join(tmpdir(), "review-panel-api-"));

  writeRecord(apiData, {
    job_id: "job_root-0000-4000-8000-000000000000",
    provider: "deepseek",
    status: "completed",
    workspace_root: "/",
    result: "Verdict: APPROVE",
  });

  const records = collectReviewPanelRecords({
    cwd: workspace,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-claude-")),
      GEMINI_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-gemini-")),
      KIMI_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-kimi-")),
      GROK_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-grok-")),
      API_REVIEWERS_PLUGIN_DATA: apiData,
    },
  });

  assert.deepEqual(records.map((record) => record.job_id), []);
});

test("review panel rejects non-repo ancestor workspace records", () => {
  const parentWorkspace = mkdtempSync(join(tmpdir(), "review-panel-parent-"));
  const childWorkspace = join(parentWorkspace, "packages", "tool");
  mkdirSync(childWorkspace, { recursive: true });
  const apiData = mkdtempSync(join(tmpdir(), "review-panel-api-"));

  writeRecord(apiData, {
    job_id: "job_parent-0000-4000-8000-000000000000",
    provider: "deepseek",
    status: "completed",
    workspace_root: parentWorkspace,
    result: "Verdict: APPROVE",
  });

  const records = collectReviewPanelRecords({
    cwd: childWorkspace,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-claude-")),
      GEMINI_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-gemini-")),
      KIMI_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-kimi-")),
      GROK_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-grok-")),
      API_REVIEWERS_PLUGIN_DATA: apiData,
    },
  });

  assert.deepEqual(records.map((record) => record.job_id), []);
});

test("review panel readiness ignores stale grok error codes outside failed jobs", () => {
  const rows = buildReviewPanelRows([
    {
      provider: "grok",
      status: "running",
      error_code: "grok_session_expired",
      external_review: { source_content_transmission: "sent" },
    },
    {
      provider: "grok",
      status: "completed",
      error_code: "models_ok_chat_400",
      external_review: { source_content_transmission: "sent" },
      review_metadata: {
        audit_manifest: {
          review_quality: { failed_review_slot: false, semantic_failure_reasons: [] },
        },
      },
      result: "Verdict: APPROVE",
    },
  ]);

  assert.equal(rows[0].readiness, "unknown");
  assert.equal(rows[0].error_code, "");
  assert.equal(rows[1].readiness, "review-ready");
  assert.equal(rows[1].error_code, "");
});

test("review panel direct fallback finds records written with lexical workspace hashes", () => {
  const realWorkspace = mkdtempSync(join(tmpdir(), "review-panel-real-"));
  const linkParent = mkdtempSync(join(tmpdir(), "review-panel-link-parent-"));
  const linkWorkspace = join(linkParent, "workspace-link");
  symlinkSync(realWorkspace, linkWorkspace, "dir");
  const grokData = writerDefaultDataRoot("grok", linkWorkspace);

  writeRecord(grokData, {
    job_id: "job_grok-0000-4000-8000-000000000000",
    provider: "grok",
    status: "completed",
    workspace_root: realWorkspace,
    result: "Verdict: APPROVE",
  });

  const records = collectReviewPanelRecords({
    cwd: linkWorkspace,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-claude-")),
      GEMINI_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-gemini-")),
      KIMI_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-kimi-")),
      API_REVIEWERS_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-api-")),
      GROK_PLUGIN_DATA: "",
    },
  });

  assert.deepEqual(records.map((record) => record.job_id), [
    "job_grok-0000-4000-8000-000000000000",
  ]);

  rmSync(grokData, { recursive: true, force: true });
});

test("review panel direct fallback finds symlink-written records from canonical cwd", () => {
  const realWorkspace = mkdtempSync(join(tmpdir(), "review-panel-real-"));
  const linkParent = mkdtempSync(join(tmpdir(), "review-panel-link-parent-"));
  const linkWorkspace = join(linkParent, "workspace-link");
  symlinkSync(realWorkspace, linkWorkspace, "dir");
  const grokData = writerDefaultDataRoot("grok", linkWorkspace);

  writeRecord(grokData, {
    job_id: "job_grok-canonical-4000-8000-000000000000",
    provider: "grok",
    status: "completed",
    workspace_root: realWorkspace,
    result: "Verdict: APPROVE",
  });

  const records = collectReviewPanelRecords({
    cwd: realWorkspace,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-claude-")),
      GEMINI_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-gemini-")),
      KIMI_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-kimi-")),
      API_REVIEWERS_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-api-")),
      GROK_PLUGIN_DATA: "",
    },
  });

  assert.deepEqual(records.map((record) => record.job_id), [
    "job_grok-canonical-4000-8000-000000000000",
  ]);

  rmSync(grokData, { recursive: true, force: true });
});

test("review panel companion fallback finds records from git root when workspace is a subdir", () => {
  const repo = mkdtempSync(join(tmpdir(), "review-panel-repo-"));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  const subdir = join(repo, "packages", "tool");
  mkdirSync(subdir, { recursive: true });
  const stateId = companionStateIdForWorkspaceRoot(repo);
  const jobsRoot = join(tmpdir(), "claude-companion", stateId);

  writeRecord(jobsRoot, {
    job_id: "job_claude-0000-4000-8000-000000000000",
    provider: "claude",
    status: "completed",
    workspace_root: repo,
    result: "Verdict: APPROVE",
  });

  const records = collectReviewPanelRecords({
    cwd: subdir,
    env: {
      ...process.env,
      GEMINI_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-gemini-")),
      KIMI_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-kimi-")),
      GROK_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-grok-")),
      API_REVIEWERS_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-api-")),
      CLAUDE_PLUGIN_DATA: "",
    },
  });

  assert.deepEqual(records.map((record) => record.job_id), [
    "job_claude-0000-4000-8000-000000000000",
  ]);

  rmSync(jobsRoot, { recursive: true, force: true });
});

test("review panel workspace collection sorts unknown providers after known providers", () => {
  const workspace = mkdtempSync(join(tmpdir(), "review-panel-workspace-"));
  const claudeData = mkdtempSync(join(tmpdir(), "review-panel-claude-"));
  const apiData = mkdtempSync(join(tmpdir(), "review-panel-api-"));

  writeRecord(apiData, {
    id: "job_unknown-0000-4000-8000-000000000000",
    job_id: "job_unknown-0000-4000-8000-000000000000",
    provider: "unknown-provider",
    status: "completed",
    workspace_root: workspace,
  });

  writeRecord(claudeData, {
    job_id: "job_known-0000-4000-8000-000000000000",
    provider: "claude",
    status: "completed",
    workspace_root: workspace,
  }, "workspace-a");

  const records = collectReviewPanelRecords({
    cwd: workspace,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: claudeData,
      GEMINI_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-gemini-")),
      KIMI_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-kimi-")),
      GROK_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "review-panel-empty-grok-")),
      API_REVIEWERS_PLUGIN_DATA: apiData,
    },
  });

  assert.deepEqual(records.map((record) => record.provider), [
    "claude",
    "unknown-provider",
  ]);
});
