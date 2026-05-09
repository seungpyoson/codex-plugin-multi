import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildReviewPanelRows,
  renderReviewPanelMarkdown,
} from "../../scripts/lib/review-panel.mjs";

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
      status: "failed",
      readiness: "review failed",
      source_sent: "sent",
      elapsed_ms: 337917,
      semantic_failed: true,
      inspection: "blocked",
      error_code: "review_not_completed",
      http_status: "",
      reasons: "permission_blocked,not_reviewed",
    },
    {
      provider: "grok",
      status: "failed",
      readiness: "not review-ready",
      source_sent: "not_sent",
      elapsed_ms: 554,
      semantic_failed: true,
      inspection: "unknown",
      error_code: "models_ok_chat_400",
      http_status: 400,
      reasons: "provider_unavailable",
    },
    {
      provider: "glm",
      status: "completed",
      readiness: "review-ready",
      source_sent: "sent",
      elapsed_ms: 45422,
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

  assert.match(markdown, /Provider \| Readiness \| Status \| Source Sent \| Elapsed/);
  assert.match(markdown, /claude \| review failed \| failed \| sent \| 70906/);
  assert.match(markdown, /review_not_completed/);
  assert.match(markdown, /not_reviewed/);
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

  assert.match(output, /deepseek \| review-ready \| completed \| sent \| 44211/);
});
