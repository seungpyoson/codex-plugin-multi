# T075 Kimi A1 Direct API Runtime Excerpt

Purpose: small source packet for Kimi review after full `plugins/api-reviewers/scripts/api-reviewer.mjs` review slots failed by timeout/shallow output.

This file is not canonical task truth. `specs/140-no-mistakes-provider-readiness/tasks.md` remains the canonical task list and completion ledger.

Source file: `plugins/api-reviewers/scripts/api-reviewer.mjs`
Full-file SHA-256 at packet creation: `870caf75193083d075b708f9eb02efe98990a1b976962821af19a5b8810922a7`

Review question: does direct API `run` perform an immediate source-free pre-send provider probe before any selected-source provider call, so stale `doctor` success cannot authorize later source send?

## Excerpt A: Probe Prompt Constant

Source lines 35-48:

```js
const API_REVIEWER_STATE_LOCK_POLL_MS = 25;
const API_REVIEWER_STATE_LOCK_TIMEOUT_MS = 5000;
const API_REVIEWER_STATE_LOCK_STALE_MS = 30000;
const SCOPE_FILE_OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const MAX_SCOPE_FILE_BYTES = 256 * 1024;
const MAX_SCOPE_TOTAL_BYTES = 1024 * 1024;
const DEFAULT_MAX_PROMPT_CHARS = 600000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 900000;
const DOCTOR_PROBE_PROMPT = "Return exactly: ok";
const GIT_SHOW_MAX_BUFFER_BYTES = MAX_SCOPE_FILE_BYTES + 1;
const API_REVIEWER_EXPECTED_KEYS = Object.freeze([
  "id",
  "job_id",
  "target",
```

## Excerpt B: Source-Free Pre-Send Probe

Source lines 1200-1260:

```js
function sourceFreeProviderProbeFields(execution, cfg) {
  const status = execution.exitCode === 0 && execution.parsed?.ok === true
    ? "ok"
    : (execution.parsed?.reason ?? "provider_error");
  return {
    status,
    http_status: execution.http_status ?? null,
    endpoint: execution.endpoint ?? baseUrlFor(cfg),
    model: cfg.model,
    raw_model: execution.parsed?.raw_model ?? null,
    source_content_transmission: SOURCE_CONTENT_TRANSMISSION.NOT_SENT,
    prompt_chars: DOCTOR_PROBE_PROMPT.length,
  };
}

function sourceFreePreSendFailureExecution(execution, cfg, env = process.env) {
  const effectiveEnv = credentialEnvWithCache(cfg, env);
  const providerProbe = sourceFreeProviderProbeFields(execution, cfg);
  const errorMessage = redactor(effectiveEnv, cfg.env_keys)(
    execution.parsed?.error ?? providerProbe.status,
  );
  const credential = selectedCredential(cfg, effectiveEnv);
  return {
    ...providerFailureWithDiagnostics(
      providerProbe.status,
      errorMessage,
      execution.http_status ?? null,
      execution.parsed?.raw ?? null,
      false,
      {
        ...(execution.diagnostics ?? {}),
        source_free_preflight: {
          ...providerProbe,
          error_message: errorMessage,
        },
      },
    ),
    credential_ref: execution.credential_ref ?? credential.keyName ?? null,
    endpoint: execution.endpoint ?? baseUrlFor(cfg),
  };
}

function sourceFreePreSendProbeEnv(env = process.env) {
  const next = { ...env };
  delete next.API_REVIEWERS_MOCK_ASSERT_PROMPT_INCLUDES;
  delete next.API_REVIEWERS_MOCK_ASSERT_PROMPT_EXCLUDES;
  delete next.API_REVIEWERS_MOCK_ASSERT_REQUEST_BODY;
  return next;
}

async function sourceFreePreSendFailure(provider, cfg, env = process.env) {
  const execution = await callProvider(provider, cfg, DOCTOR_PROBE_PROMPT, sourceFreePreSendProbeEnv(env));
  if (execution.exitCode === 0 && execution.parsed?.ok === true) return null;
  return sourceFreePreSendFailureExecution(execution, cfg, env);
}

async function doctorFields(provider, cfg, env = process.env) {
  const credential = selectedCredential(cfg, env);
  const endpoint = baseUrlFor(cfg);
  const costQuotaReadiness = {
    status: "unknown_not_probed",
```

## Excerpt C: `cmdRun` Ordering

Source lines 2691-2855:

```js
async function cmdRun(options) {
  const provider = options.provider ?? null;
  const mode = options.mode ?? "review";
  let approvalScope = "session";
  let lifecycleEvents = null;
  const startedAt = new Date().toISOString();
  const jobId = `job_${randomUUID()}`;
  const runOptions = { ...options, jobId };
  let providers;
  let cfg;
  let scopeInfo;
  let execution;
  try {
    lifecycleEvents = parseLifecycleEventsMode(options["lifecycle-events"]);
    if (!provider) throw runBadArgs("bad_args: --provider is required");
    if (!VALID_MODES.has(mode)) throw runBadArgs(`bad_args: unsupported --mode ${mode}`);
    approvalScope = approvalScopeForOptions(options);
    try {
      providers = await loadProviders();
    } catch (e) {
      throw runConfigError(`config_error: ${providersConfigErrorMessage(e)}`);
    }
    try {
      cfg = providerConfig(providers, provider);
    } catch (e) {
      throw runBadArgs(e.message);
    }
    const preflight = validateDirectApiRunPreflight(cfg, provider, process.env);
    if (!preflight.ok && preflight.reason === "bad_args") throw runBadArgs(preflight.error);
    if (!preflight.ok) throw runProviderFailure(preflight.reason, preflight.error);
    if (!hasPromptText(options.prompt)) throw runBadArgs("bad_args: prompt is required (pass --prompt <focus>)");
    const statePreflight = await verifyApiReviewerDataRootWritable(
      process.env,
      options.cwd ? resolve(options.cwd) : process.cwd(),
    );
    if (!statePreflight.ok) throw runProviderFailure("sandbox_blocked", statePreflight.error);
    scopeInfo = await collectScope({ ...runOptions, mode });
  } catch (e) {
    const redact = redactor();
    const policyError = isGitBinaryPolicyError(e);
    const reason = policyError ? "git_binary_rejected" : (e.apiReviewersReason ?? "scope_failed");
    cfg ??= fallbackProviderConfig(provider);
    const cwd = resolve(process.cwd());
    scopeInfo = {
      cwd,
      workspaceRoot: policyError ? cwd : bestEffortWorkspaceRoot(cwd),
      scope: options.scope ?? null,
      scope_base: options["scope-base"] ?? null,
      scope_paths: splitScopePaths(options["scope-paths"]),
    };
    execution = {
      exitCode: 1,
      parsed: { ok: false, reason, error: redact(e.message) },
      payload_sent: false,
    };
  }
  if (!execution) {
    let renderedPrompt = null;
    try {
      renderedPrompt = promptFor(mode, options.prompt ?? "", scopeInfo, cfg.display_name);
      const promptBudget = validateRenderedPromptBudget(renderedPrompt, cfg, process.env);
      if (!promptBudget.ok) {
        execution = providerFailure(promptBudget.reason, redactor(process.env)(promptBudget.error), null, null, false);
        execution.prompt = renderedPrompt;
      }
      if (!execution && shouldRequireApprovalToken(process.env)) {
        const request = requestSettingsForApproval(cfg);
        const authPath = approvalAuthPathFor(cfg, process.env);
        const billingPath = approvalBillingPathFor(cfg);
        const routeFields = approvalRouteFields(routeStateForApproval(cfg, process.env));
        const auditManifest = buildApprovalAuditManifest({ cfg, renderedPrompt, request, scopeInfo, routeFields, approvalScope });
        const expectedToken = approvalTokenFor({ provider, mode, auditManifest, authPath, billingPath, routeFields, approvalScope });
        if (!validateApprovalToken(options, expectedToken)) {
          execution = providerFailureWithDiagnostics(
            "approval_required",
            "approval_required: run approval-request, show the approval summary to the user, and pass the returned approval_token.value with --approval-token after explicit approval",
            null,
            null,
            false,
            approvalDiagnostics(cfg, request, renderedPrompt, authPath, billingPath, routeFields, approvalScope),
          );
          execution.prompt = renderedPrompt;
        } else if (
          approvalScope === "once" &&
          await oneTimeApprovalAlreadyUsed(
            apiReviewerDataRoot(process.env, scopeInfo.workspaceRoot ?? scopeInfo.cwd),
            options["approval-token"],
          )
        ) {
          execution = providerFailureWithDiagnostics(
            "approval_required",
            "approval_required: one-time approval token has already been used; run approval-request again before source is sent",
            null,
            null,
            false,
            approvalDiagnostics(cfg, request, renderedPrompt, authPath, billingPath, routeFields, approvalScope),
          );
          execution.prompt = renderedPrompt;
        }
      }
    } catch (e) {
      execution = providerFailure("scope_failed", redactor(process.env)(e?.message ?? String(e)), null, null, false);
    }
    if (execution) {
      // handled below by the terminal JobRecord path without a launch event
    } else {
      execution = await sourceFreePreSendFailure(provider, cfg, process.env);
    }
    if (execution) {
      execution.prompt = renderedPrompt;
      // handled below by the terminal JobRecord path without a launch event
    } else {
      if (approvalScope === "once" && shouldRequireApprovalToken(process.env)) {
        const consumed = await consumeOneTimeApproval(
          apiReviewerDataRoot(process.env, scopeInfo.workspaceRoot ?? scopeInfo.cwd),
          options["approval-token"],
          {
            provider,
            mode,
            job_id: jobId,
            consumed_at: new Date().toISOString(),
          },
        );
        if (!consumed) {
          execution = providerFailureWithDiagnostics(
            "approval_required",
            "approval_required: one-time approval token has already been used; run approval-request again before source is sent",
            null,
            null,
            false,
            { approval_scope: approvalScope },
          );
          execution.prompt = renderedPrompt;
        }
      }
    }
    if (execution) {
      // handled below by the terminal JobRecord path without a launch event
    } else {
      if (lifecycleEvents) {
        printLifecycleJson({
          event: "external_review_launched",
          job_id: jobId,
          target: provider,
          status: "launched",
          external_review: buildLaunchExternalReview({ cfg, mode, options: runOptions, scopeInfo }),
        }, lifecycleEvents);
      }
      const stopHeartbeat = startLifecycleHeartbeat({
        job_id: jobId,
        target: provider,
        mode,
        cwd: scopeInfo.cwd,
        workspace_root: scopeInfo.workspaceRoot,
        external_review: buildLaunchExternalReview({ cfg, mode, options: runOptions, scopeInfo }),
      }, lifecycleEvents);
      try {
        execution = await callProvider(provider, cfg, renderedPrompt);
        execution.prompt = renderedPrompt;
      } catch (e) {
        execution = providerFailure("provider_unavailable", redactor(process.env)(e?.message ?? String(e)), null, null, null);
        execution.prompt = renderedPrompt;
      } finally {
        stopHeartbeat();
      }
```
