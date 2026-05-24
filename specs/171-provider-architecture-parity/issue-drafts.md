# Issue Drafts

Status: no issues ready to file.

This is the manual `speckit-taskstoissues` conversion result for the current
#171 root-problem pass. The stock Speckit command would create GitHub issues,
but issue creation is blocked by the operator rule below until root cause,
duplicate check, and explicit approval are all present.

Do not create GitHub issues from this file until:

1. Root cause is proven with source/job evidence.
2. Duplicate check against #171, #159, #172, and #173 is recorded.
3. Operator explicitly approves issue creation.

## Grok Login Persistence

Draft status: blocked on evidence. Do not file.

Current evidence:

- Current local source-free checks pass. `grok models` reports a grok.com login
  and `grok-build`; plugin `doctor` reports `ready:true`, `logged_in:true`, and
  `model_ready:true`.
- Existing local Grok JobRecords in this repo did not contain
  `grok_cli_login_required`.
- Historical spec-140 evidence shows the symptom has happened in another
  execution context with Grok CLI `logged_in:false` while Grok web was ready.

Current hypothesis list:

- The failed job used a different `GROK_CLI_AUTH_HOME`, `GROK_HOME`, binary, or
  execution environment than the current shell.
- Session state expired between readiness and review.
- The `grok models` output parser or runtime-home copy path misclassified a
  valid login.
- The job was stale and no longer reflects current CLI state.

Current classification: #171/#159 evidence, not separate issue yet.

Duplicate check:

- GitHub search for `grok_cli_login_required`, `Grok login required`, and
  `login_required logged_in false` found no open exact duplicate.
- #159 already owns Grok provider architecture and CLI/web fallback parity.
- #171 already owns shared readiness/auth-state policy across all six
  providers.
- Current local `grok-web-reviewer.mjs doctor` returns `ready:true`,
  `logged_in:true`, `model_ready:true`, and source-free prompt readiness.

Task-to-issue decision: no GitHub issue. The symptom is not reproducible in
current state and the exact failed JobRecord/environment is missing.

Required before filing:

- Exact failed JobRecord or command output.
- Failed job environment facts: selected binary, `GROK_CLI_AUTH_HOME`,
  `GROK_HOME`, requested transport, and redacted `grok models` output.
- Duplicate check against #159 and #171.

## Kimi Step Limit

Draft status: candidate evidence recorded; GitHub issue still blocked pending
operator approval and final duplicate decision.

Current hypothesis list:

- Large source-bearing packets exceed Kimi step budget after source send.
- Shared packet budget policy fails to preflight Kimi capacity before launch.
- Kimi lacks direct API/OpenRouter route capability in the shared ladder.

Current classification: #171/#172 evidence, not separate issue yet.

Current evidence:

- `/private/tmp/cpm-171-plan-review/kimi-result.json`,
  `/private/tmp/cpm-171-final-review/kimi-final2.json`, and
  `/private/tmp/cpm-171-final-review/kimi-final4.json` all failed after source
  send as `custom-review` with `step_limit_exceeded`.
- Kimi job `abdc226d-d5b1-4b12-b19a-f7cf9eb6cb69` sent a minimal one-file
  `provider-parity-table.json` packet and failed with `timeout` after
  257,212 ms with no stdout, stderr, or verdict.
- Kimi job `3c39881a-2875-4ba8-a785-ae3bcca4c2f8` sent a one-file `plan.md`
  packet of 7,696 bytes and failed with `timeout` after 904,740 ms with no
  stdout, stderr, or verdict. This happened after Kimi successfully approved
  one-file `root-problems.md` and `spec.md` packets, so the symptom is not
  explained by packet byte size alone.
- Kimi job `7a870d59-edab-4a49-b968-fa44136080b9` approved compact `plan.md`
  after the plan was reduced to 5,694 bytes, but job
  `c14df593-ce72-4a5a-ba3e-0a1e20b80227` then sent the old `tasks.md` packet
  and became stale after the timeout budget plus grace with no stdout, stderr,
  or verdict.
- Kimi job `ea4c9156-8a96-449f-ac99-2c87ad52d57b` sent the four-file current
  planning packet of 35,495 bytes and failed with wall-clock `timeout` after
  907,148 ms with no verdict.
- Kimi companion and JobRecord tests intentionally classify the sentinel as a
  runtime budget failure after source transmission.

Duplicate check:

- GitHub search for `Kimi step_limit_exceeded timeout custom-review source sent`
  returns #172.
- GitHub search for `Kimi Code CLI timeout source sent review` returns #172 but
  no exact minimal-packet timeout issue.
- GitHub search for `source_sent_timeout Kimi review timeout` found no open
  exact duplicate.
- #172 covers large custom-review packets and Kimi `step_limit_exceeded` after
  source send.
- #173 covers provider-neutral subscription CLI source-packet budget gates for
  Claude, Gemini, and Kimi.

Task-to-issue decision: do not file automatically. The minimal-packet timeout is
new evidence that Kimi has a source-sent runtime capacity/transport failure, but
#171/#172/#173 already own the shared-policy fix. File a separate Kimi issue only
if the same timeout remains after shared route, packet, timeout, and resend
policy is accepted or if the operator explicitly wants a tracking issue for this
Kimi-specific transport symptom.

Required before filing:

- Proof that the timeout/step-limit symptom remains after the shared packet
  budget, timeout budget, and route ladder design is accepted.
- Duplicate check against #172 and #171.
- Explicit operator approval to create the issue.
