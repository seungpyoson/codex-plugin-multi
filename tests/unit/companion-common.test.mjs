import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PING_PROMPT,
  comparePathStrings,
  consumePromptSidecar,
  credentialNameDiagnostics,
  externalReviewLaunchedEvent,
  gitStatusLines,
  parseLifecycleEventsMode,
  parseScopePathsOption,
  preflightDisclosure,
  preflightSafetyFields,
  printJson,
  printJsonLine,
  printLifecycleJson,
  promptSidecarPath,
  runKindFromRecord,
  summarizeScopeDirectory,
  writePromptSidecar,
} from "../../scripts/lib/companion-common.mjs";
import { COMPANION_PLUGIN_TARGETS } from "../../scripts/lib/plugin-targets.mjs";

const POSIX_MODE_ASSERTIONS = process.platform !== "win32";

test("companion-common exposes the shared ping prompt", () => {
  assert.equal(
    PING_PROMPT,
    "reply with exactly: pong. Do not use any tools, do not read files, and do not explore the workspace.",
  );
});

test("companion-common builds provider preflight safety fields", () => {
  assert.deepEqual(preflightSafetyFields(), {
    target_spawned: false,
    selected_scope_sent_to_provider: false,
    requires_external_provider_consent: true,
  });
  assert.match(preflightDisclosure("Claude"), /Claude was not spawned/);
  assert.match(preflightDisclosure("Gemini"), /external review still sends/);
});

test("credentialNameDiagnostics reports key names only", () => {
  const result = credentialNameDiagnostics(["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"], {
    ANTHROPIC_API_KEY: "secret-test-value",
    CLAUDE_API_KEY: "",
  });
  assert.deepEqual(result, {
    ignored_env_credentials: ["ANTHROPIC_API_KEY"],
    auth_policy: "api_key_env_ignored",
  });
  assert.doesNotMatch(JSON.stringify(result), /secret-test-value/);
});

test("credentialNameDiagnostics omits fields when no provider key is present", () => {
  assert.deepEqual(credentialNameDiagnostics(["ANTHROPIC_API_KEY"], {}), {});
});

test("shared companion helpers cover small provider-agnostic behavior", () => {
  let printed = "";
  printJson({ ok: true }, { write: (chunk) => { printed += chunk; } });
  assert.equal(printed, "{\n  \"ok\": true\n}\n");
  let compact = "";
  printJsonLine({ ok: true }, { write: (chunk) => { compact += chunk; } });
  assert.equal(compact, "{\"ok\":true}\n");
  let lifecyclePretty = "";
  printLifecycleJson({ ok: true }, null, { write: (chunk) => { lifecyclePretty += chunk; } });
  assert.equal(lifecyclePretty, "{\n  \"ok\": true\n}\n");
  let lifecycleJsonl = "";
  printLifecycleJson({ ok: true }, "jsonl", { write: (chunk) => { lifecycleJsonl += chunk; } });
  assert.equal(lifecycleJsonl, "{\"ok\":true}\n");
  assert.equal(parseLifecycleEventsMode(undefined), null);
  assert.equal(parseLifecycleEventsMode(false), null);
  assert.equal(parseLifecycleEventsMode("jsonl"), "jsonl");
  assert.throws(() => parseLifecycleEventsMode("pretty"), /--lifecycle-events must be jsonl/);
  assert.deepEqual(
    externalReviewLaunchedEvent(
      { job_id: "job-1", target: "claude" },
      { marker: "EXTERNAL REVIEW" },
    ),
    {
      event: "external_review_launched",
      job_id: "job-1",
      target: "claude",
      status: "launched",
      external_review: { marker: "EXTERNAL REVIEW" },
    },
  );
  assert.deepEqual(parseScopePathsOption(" a.js, ,src/b.js "), ["a.js", "src/b.js"]);
  assert.equal(parseScopePathsOption(""), null);
  assert.deepEqual(["b", "a", "aa"].sort(comparePathStrings), ["a", "aa", "b"]);
  assert.deepEqual(gitStatusLines(" M a.js  \n\n?? b.js\n"), [" M a.js", "?? b.js"]);
  assert.equal(runKindFromRecord({ external_review: { run_kind: "foreground" } }), "foreground");
  assert.equal(runKindFromRecord({}), "unknown");
});

test("summarizeScopeDirectory returns sorted files and byte totals", () => {
  const root = mkdtempSync(path.join(tmpdir(), "companion-common-scope-"));
  const nested = path.join(root, "nested");
  fsMkdir(nested);
  fsWrite(path.join(root, "b.txt"), "bb");
  fsWrite(path.join(nested, "a.txt"), "aaa");

  assert.deepEqual(summarizeScopeDirectory(root), {
    files: ["b.txt", "nested/a.txt"],
    file_count: 2,
    byte_count: 5,
  });
  assert.deepEqual(summarizeScopeDirectory(path.join(root, "missing")), {
    files: [],
    file_count: 0,
    byte_count: 0,
  });
});

test("prompt sidecar helpers write 0600 handoff files and consume once", () => {
  const jobsDir = mkdtempSync(path.join(tmpdir(), "companion-common-jobs-"));
  const p = promptSidecarPath(jobsDir, "job-1");
  assert.equal(p, path.join(jobsDir, "job-1", "prompt.txt"));
  assert.equal(consumePromptSidecar(jobsDir, "job-1"), null);

  writePromptSidecar(jobsDir, "job-1", "secret prompt");
  assert.equal(readFileSync(p, "utf8"), "secret prompt");
  if (POSIX_MODE_ASSERTIONS) {
    assert.equal((statSync(path.dirname(p)).mode & 0o777), 0o700);
    assert.equal((statSync(p).mode & 0o777), 0o600);
  }
  assert.equal(consumePromptSidecar(jobsDir, "job-1"), "secret prompt");
  assert.equal(existsSync(p), false);
  assert.equal(consumePromptSidecar(jobsDir, "job-1"), null);
});

test("prompt sidecar helpers reject unsafe job ids before resolving paths", () => {
  const jobsDir = mkdtempSync(path.join(tmpdir(), "companion-common-unsafe-jobs-"));

  for (const jobId of ["/tmp/escape", "../escape", "nested/job", "", "."]) {
    assert.throws(() => promptSidecarPath(jobsDir, jobId), /Unsafe jobId/);
    assert.throws(() => writePromptSidecar(jobsDir, jobId, "secret"), /Unsafe jobId/);
    assert.throws(() => consumePromptSidecar(jobsDir, jobId), /Unsafe jobId/);
  }
});

test("consumePromptSidecar treats ENOTDIR as a missing sidecar", () => {
  const jobsDir = mkdtempSync(path.join(tmpdir(), "companion-common-enotdir-jobs-"));
  writeFileSync(path.join(jobsDir, "job-file"), "not a directory", "utf8");

  assert.equal(consumePromptSidecar(jobsDir, "job-file"), null);
});

test("writePromptSidecar rejects symlinked job directories", { skip: process.platform === "win32" }, () => {
  const jobsDir = mkdtempSync(path.join(tmpdir(), "companion-common-symlink-jobs-"));
  const escapeDir = mkdtempSync(path.join(tmpdir(), "companion-common-symlink-escape-"));
  symlinkSync(escapeDir, path.join(jobsDir, "job-link"), "dir");

  assert.throws(
    () => writePromptSidecar(jobsDir, "job-link", "secret"),
    /not a real directory inside jobsDir|symlink/i,
  );
  assert.equal(existsSync(path.join(escapeDir, "prompt.txt")), false);
});

test("consumePromptSidecar rejects symlinked job directories", { skip: process.platform === "win32" }, () => {
  const jobsDir = mkdtempSync(path.join(tmpdir(), "companion-common-consume-symlink-jobs-"));
  const escapeDir = mkdtempSync(path.join(tmpdir(), "companion-common-consume-symlink-escape-"));
  symlinkSync(escapeDir, path.join(jobsDir, "job-link"), "dir");
  writeFileSync(path.join(escapeDir, "prompt.txt"), "attacker prompt", "utf8");

  assert.throws(
    () => consumePromptSidecar(jobsDir, "job-link"),
    /not a real directory inside jobsDir|symlink/i,
  );
  assert.equal(readFileSync(path.join(escapeDir, "prompt.txt"), "utf8"), "attacker prompt");
});

test("consumePromptSidecar returns the prompt when cleanup unlink fails", {
  skip: !POSIX_MODE_ASSERTIONS || process.getuid?.() === 0,
}, () => {
  const jobsDir = mkdtempSync(path.join(tmpdir(), "companion-common-unlink-fails-"));
  const p = promptSidecarPath(jobsDir, "job-1");
  writePromptSidecar(jobsDir, "job-1", "secret prompt");
  const dir = path.dirname(p);

  chmodSync(dir, 0o500);
  try {
    assert.equal(consumePromptSidecar(jobsDir, "job-1"), "secret prompt");
    assert.equal(readFileSync(p, "utf8"), "secret prompt");
  } finally {
    chmodSync(dir, 0o700);
    try { unlinkSync(p); } catch { /* best-effort test cleanup */ }
  }
});

test("plugin packaging copies expose the canonical helper behavior", async () => {
  const modules = await Promise.all(
    COMPANION_PLUGIN_TARGETS.map((plugin) =>
      import(`../../plugins/${plugin}/scripts/lib/companion-common.mjs`)
    )
  );
  for (const [i, mod] of modules.entries()) {
    const plugin = COMPANION_PLUGIN_TARGETS[i];
    assert.equal(mod.PING_PROMPT, PING_PROMPT);
    assert.deepEqual(mod.preflightSafetyFields(), preflightSafetyFields());
    assert.equal(mod.preflightDisclosure("Target"), preflightDisclosure("Target"));
    assert.deepEqual(
      mod.credentialNameDiagnostics(["PROVIDER_API_KEY"], { PROVIDER_API_KEY: "secret-test-value" }),
      credentialNameDiagnostics(["PROVIDER_API_KEY"], { PROVIDER_API_KEY: "secret-test-value" }),
    );
    assert.deepEqual(
      mod.credentialNameDiagnostics(["__CODEX_PLUGIN_MULTI_MISSING_TEST_KEY__"]),
      credentialNameDiagnostics(["__CODEX_PLUGIN_MULTI_MISSING_TEST_KEY__"]),
    );
    assert.deepEqual(mod.parseScopePathsOption("one,two"), ["one", "two"]);
    assert.deepEqual(mod.gitStatusLines(" M x\n"), [" M x"]);
    assert.equal(mod.runKindFromRecord({}), "unknown");
    assertCopyHelperBranches(mod, plugin);
  }
});

function assertCopyHelperBranches(mod, plugin) {
  let printed = "";
  mod.printJson({ plugin }, { write: (chunk) => { printed += chunk; } });
  assert.equal(printed, `{\n  "plugin": "${plugin}"\n}\n`);
  let compact = "";
  mod.printJsonLine({ plugin }, { write: (chunk) => { compact += chunk; } });
  assert.equal(compact, `{"plugin":"${plugin}"}\n`);
  let lifecyclePretty = "";
  mod.printLifecycleJson({ plugin }, null, { write: (chunk) => { lifecyclePretty += chunk; } });
  assert.equal(lifecyclePretty, `{\n  "plugin": "${plugin}"\n}\n`);
  let lifecycleJsonl = "";
  mod.printLifecycleJson({ plugin }, "jsonl", { write: (chunk) => { lifecycleJsonl += chunk; } });
  assert.equal(lifecycleJsonl, `{"plugin":"${plugin}"}\n`);
  assert.equal(mod.parseLifecycleEventsMode(undefined), null);
  assert.equal(mod.parseLifecycleEventsMode(false), null);
  assert.equal(mod.parseLifecycleEventsMode("jsonl"), "jsonl");
  assert.throws(() => mod.parseLifecycleEventsMode("pretty"), /--lifecycle-events must be jsonl/);
  assert.deepEqual(
    mod.externalReviewLaunchedEvent(
      { job_id: "copy-job", target: plugin },
      { marker: "EXTERNAL REVIEW" },
    ),
    {
      event: "external_review_launched",
      job_id: "copy-job",
      target: plugin,
      status: "launched",
      external_review: { marker: "EXTERNAL REVIEW" },
    },
  );

  assert.equal(mod.parseScopePathsOption(""), null);
  assert.deepEqual(mod.parseScopePathsOption(" a.js, ,b.js "), ["a.js", "b.js"]);
  assert.equal(mod.comparePathStrings("a", "b"), -1);
  assert.equal(mod.comparePathStrings("b", "a"), 1);
  assert.equal(mod.comparePathStrings("a", "a"), 0);

  const root = mkdtempSync(path.join(tmpdir(), `companion-common-copy-${plugin}-`));
  const nested = path.join(root, "nested");
  fsMkdir(nested);
  fsWrite(path.join(root, "b.txt"), "bb");
  fsWrite(path.join(nested, "a.txt"), "aaa");
  fsMkdir(path.join(root, "empty-dir"));
  assert.deepEqual(mod.summarizeScopeDirectory(root), {
    files: ["b.txt", "nested/a.txt"],
    file_count: 2,
    byte_count: 5,
  });
  assert.deepEqual(mod.summarizeScopeDirectory(path.join(root, "missing")), {
    files: [],
    file_count: 0,
    byte_count: 0,
  });

  assert.deepEqual(mod.gitStatusLines(" M a.js  \n\n?? b.js\n"), [" M a.js", "?? b.js"]);
  assert.equal(mod.runKindFromRecord({ external_review: { run_kind: "background" } }), "background");
  assert.equal(mod.runKindFromRecord({}), "unknown");

  const jobsDir = mkdtempSync(path.join(tmpdir(), `companion-common-copy-jobs-${plugin}-`));
  assert.equal(mod.consumePromptSidecar(jobsDir, "job-1"), null);
  mod.writePromptSidecar(jobsDir, "job-1", "copy prompt");
  const sidecar = mod.promptSidecarPath(jobsDir, "job-1");
  assert.equal(readFileSync(sidecar, "utf8"), "copy prompt");
  if (POSIX_MODE_ASSERTIONS) {
    assert.equal((statSync(path.dirname(sidecar)).mode & 0o777), 0o700);
    assert.equal((statSync(sidecar).mode & 0o777), 0o600);
  }
  assert.equal(mod.consumePromptSidecar(jobsDir, "job-1"), "copy prompt");
  assert.equal(existsSync(sidecar), false);
  assert.equal(mod.consumePromptSidecar(jobsDir, "job-1"), null);

  const enotdirJobsDir = mkdtempSync(path.join(tmpdir(), `companion-common-copy-enotdir-${plugin}-`));
  writeFileSync(path.join(enotdirJobsDir, "job-file"), "not a directory", "utf8");
  assert.equal(mod.consumePromptSidecar(enotdirJobsDir, "job-file"), null);

  if (process.platform !== "win32") {
    const writeSymlinkJobsDir = mkdtempSync(path.join(tmpdir(), `companion-common-copy-write-symlink-${plugin}-`));
    const writeEscapeDir = mkdtempSync(path.join(tmpdir(), `companion-common-copy-write-escape-${plugin}-`));
    symlinkSync(writeEscapeDir, path.join(writeSymlinkJobsDir, "job-link"), "dir");
    assert.throws(
      () => mod.writePromptSidecar(writeSymlinkJobsDir, "job-link", "copy secret"),
      /not a real directory inside jobsDir|symlink/i,
    );
    assert.equal(existsSync(path.join(writeEscapeDir, "prompt.txt")), false);

    const consumeSymlinkJobsDir = mkdtempSync(path.join(tmpdir(), `companion-common-copy-consume-symlink-${plugin}-`));
    const consumeEscapeDir = mkdtempSync(path.join(tmpdir(), `companion-common-copy-consume-escape-${plugin}-`));
    symlinkSync(consumeEscapeDir, path.join(consumeSymlinkJobsDir, "job-link"), "dir");
    writeFileSync(path.join(consumeEscapeDir, "prompt.txt"), "attacker prompt", "utf8");
    assert.throws(
      () => mod.consumePromptSidecar(consumeSymlinkJobsDir, "job-link"),
      /not a real directory inside jobsDir|symlink/i,
    );
    assert.equal(readFileSync(path.join(consumeEscapeDir, "prompt.txt"), "utf8"), "attacker prompt");
  }

  assert.deepEqual(mod.credentialNameDiagnostics(["KEY"], {}), {});
  assert.deepEqual(mod.credentialNameDiagnostics(["KEY"], { KEY: "value" }), {
    ignored_env_credentials: ["KEY"],
    auth_policy: "api_key_env_ignored",
  });
}

function fsMkdir(dir) {
  mkdirSync(dir, { recursive: true });
}

function fsWrite(file, contents) {
  writeFileSync(file, contents, "utf8");
  chmodSync(file, 0o600);
}

test("external-review plugin copies keep stale no-pid transmission unknown", async () => {
  const modules = await Promise.all(
    COMPANION_PLUGIN_TARGETS.map((plugin) =>
      import(`../../plugins/${plugin}/scripts/lib/external-review.mjs`)
    )
  );
  for (const mod of modules) {
    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "stale",
      errorCode: "stale_active_job",
      pidInfo: null,
    }), mod.SOURCE_CONTENT_TRANSMISSION.UNKNOWN);
  }
});

test("external-review shared helper covers disclosure and transmission branches", async () => {
  const modules = await Promise.all(
    COMPANION_PLUGIN_TARGETS.map((plugin) =>
      import(`../../plugins/${plugin}/scripts/lib/external-review.mjs`)
    )
  );

  for (const mod of modules) {
    const T = mod.SOURCE_CONTENT_TRANSMISSION;
    assert.equal(mod.providerDisplayName("claude"), "Claude Code");
    assert.equal(mod.providerDisplayName("unknown-target"), "unknown-target");
    assert.equal(mod.targetProcessReceivedContent("timeout"), true);
    assert.equal(mod.targetProcessReceivedContent("scope_failed"), false);

    assert.equal(
      mod.externalReviewDisclosure("Provider", "queued", T.MAY_BE_SENT),
      "Selected source content may be sent to Provider for external review.",
    );
    assert.equal(
      mod.externalReviewDisclosure("Provider", "completed", T.SENT),
      "Selected source content was sent to Provider for external review.",
    );
    assert.equal(
      mod.externalReviewDisclosure("Provider", "running", T.SENT),
      "Selected source content was sent to Provider for external review; the run is in progress.",
    );
    assert.equal(
      mod.externalReviewDisclosure("Provider", "cancelled", T.SENT),
      "Selected source content was sent to Provider for external review; the operator cancelled the run before it completed.",
    );
    assert.equal(
      mod.externalReviewDisclosure("Provider", "failed", T.SENT),
      "Selected source content was sent to Provider for external review, but the run ended before a clean result was produced.",
    );
    assert.equal(
      mod.externalReviewDisclosure("Provider", "cancelled", T.NOT_SENT),
      "Selected source content was not sent to Provider; the operator cancelled the run before the target process was started.",
    );
    assert.equal(
      mod.externalReviewDisclosure("Provider", "failed", T.NOT_SENT, "scope_failed"),
      "Selected source content was not sent to Provider; the review scope was rejected before the target process was started.",
    );
    assert.equal(
      mod.externalReviewDisclosure("Provider", "failed", T.NOT_SENT, "spawn_failed"),
      "Selected source content was not sent to Provider; the target process was not spawned.",
    );
    assert.equal(
      mod.externalReviewDisclosure("Provider", "failed", T.NOT_SENT, "unknown_pre_spawn"),
      "Selected source content was not sent to Provider; the target process was not started.",
    );
    assert.equal(
      mod.externalReviewDisclosure("Provider", "stale", T.UNKNOWN),
      "Selected source content may have been sent to Provider; the run became stale before completion.",
    );
    assert.equal(
      mod.externalReviewDisclosure("Provider", "failed", T.UNKNOWN),
      "Selected source content may have been sent to Provider; the run ended before a clean result was produced.",
    );

    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "queued",
      errorCode: null,
      pidInfo: null,
    }), T.MAY_BE_SENT);
    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "running",
      errorCode: null,
      pidInfo: { pid: 1 },
    }), T.SENT);
    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "running",
      errorCode: null,
      pidInfo: null,
    }), T.MAY_BE_SENT);
    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "stale",
      errorCode: "stale_active_job",
      pidInfo: { pid: 1 },
    }), T.SENT);
    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "failed",
      errorCode: "scope_failed",
      pidInfo: null,
    }), T.NOT_SENT);
    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "failed",
      errorCode: "spawn_failed",
      pidInfo: null,
    }), T.NOT_SENT);
    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "cancelled",
      errorCode: null,
      pidInfo: { pid: 1 },
    }), T.SENT);
    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "cancelled",
      errorCode: null,
      pidInfo: null,
    }), T.NOT_SENT);
    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "completed",
      errorCode: null,
      pidInfo: null,
    }), T.SENT);
    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "failed",
      errorCode: "parse_error",
      pidInfo: null,
    }), T.SENT);
    assert.equal(mod.sourceContentTransmissionForExecution({
      status: "failed",
      errorCode: "unknown_target_failure",
      pidInfo: null,
    }), T.UNKNOWN);

    const review = mod.buildExternalReview({
      invocation: {
        target: "kimi",
        run_kind: "background",
        job_id: "job-123",
        parent_job_id: "parent-1",
        mode: "review",
        scope: "custom",
        scope_base: "main",
        scope_paths: ["src/file.mjs"],
      },
      sessionId: "session-1",
      status: "completed",
      sourceContentTransmission: T.SENT,
    });
    assert.equal(review.provider, "Kimi Code CLI");
    assert.equal(review.run_kind, "background");
    assert.equal(review.session_id, "session-1");
    assert.deepEqual(review.scope_paths, ["src/file.mjs"]);
    assert.throws(() => {
      review.marker = "mutated";
    }, TypeError);
  }
});
