# Review Results: Grok CLI-Primary Transport Parity

**Scope**: Pre-implementation planning packet for #159.
**Packet**:

- `spec.md`
- `plan.md`
- `tasks.md`
- `evidence-map.md`
- `research.md`
- `data-model.md`
- `contracts/grok-transport-adapter.md`
- `quickstart.md`

## Current Planning Gate Status

Planning gate passed for implementation. The initial committed planning packet at
`91e2dac5d898e030a279d7c5d4a69ceb21df547c` received usable approvals from
DeepSeek, GLM, Claude, Gemini, and Grok, but Kimi returned a blocking contract
finding. The contract and task list were updated to address that finding, so the
required six-reviewer gate was rerun against
`6921027a8cf07082d6c2cbf635886903e718ac4b` before implementation started.

The prior exact-head JobRecords are useful audit evidence only. The patched
planning packet was approved separately at the new head. Later implementation
and documentation changes still require final latest-head implementation review
before any PR/merge-readiness claim.

## Exact-Head Planning Reviews Before Kimi Fix

### DeepSeek

- Job: `job_dd989189-d305-495e-bc5d-5426d9eb685e`
- Provider session: `e9878544-4c77-4165-ab37-6bc1d70f9267`
- Head SHA reviewed: `91e2dac5d898e030a279d7c5d4a69ceb21df547c`
- Source transmission: sent
- Verdict: APPROVE
- Blocking findings: none
- Notes: non-blocking concern about fallback-code enumeration, legacy alias
  coverage, and export-shape contract.

### GLM

- Job: `job_5d277a63-282b-41d3-9634-abd4d358886f`
- Provider session: `202605281952249ac2bf2664944983`
- Head SHA reviewed: `91e2dac5d898e030a279d7c5d4a69ceb21df547c`
- Source transmission: sent
- Verdict: APPROVE
- Blocking findings: none
- Notes: non-blocking concern about fallback-code enumeration, fallback config
  helper boundary, timeout env contract coverage, and test seams.

### Claude

- First job: `a18c29c8-7d01-4cdc-a933-d97a858bdec3`
- Source transmission: sent
- Verdict: failed review slot
- Failed reason: `permission_blocked`
- Second job: `5963fc9a-91d7-4daf-b41e-16fabedd52ff`
- Head SHA reviewed: `91e2dac5d898e030a279d7c5d4a69ceb21df547c`
- Source transmission: sent
- Verdict: APPROVE
- Blocking findings: none

### Gemini

- Job: `5624f719-1bc0-4f38-993d-cc48f4b23396`
- Provider session: `bdd6a9b1-8131-47ef-9a0a-dfde69bf63ec`
- Head SHA reviewed: `91e2dac5d898e030a279d7c5d4a69ceb21df547c`
- Source transmission: sent
- Verdict: APPROVE
- Blocking findings: none

### Grok

- Job: `job_b9f523d4-fd3b-4d7a-938e-bafd29246529`
- Route: subscription-backed Grok CLI
- Head SHA reviewed: `91e2dac5d898e030a279d7c5d4a69ceb21df547c`
- Source transmission: sent
- Verdict: APPROVE
- Blocking findings: none

### Kimi

- First job: `63fd6b1e-f8aa-407d-88e8-899a18d54fe9`
- Source transmission: not sent
- Failed reason: `source_packet_too_large`
- Second job: `f7d05f5b-6435-4a94-801b-03e800ec6cfe`
- Source packet override: `--allow-large-source-packet`
- Head SHA reviewed: `91e2dac5d898e030a279d7c5d4a69ceb21df547c`
- Source transmission: sent
- Verdict: REQUEST_CHANGES
- Blocking finding: contract fallback rules named `source_sent` safety but did
  not explicitly name legacy `payload_sent`, while `data-model.md` required both
  fields to block auto fallback when true, `sent`, or `may_be_sent`.
- Resolution: `contracts/grok-transport-adapter.md` now explicitly blocks auto
  fallback on both `source_sent` and legacy `payload_sent`; `tasks.md` now
  requires RED coverage for both fields and early fallback record construction.

## Direct API Reviews Before Local Commit

### DeepSeek

- Job: `job_7686d3d8-03e0-47b8-ba20-a6689ec527e8`
- Provider session: `3acfb648-a84b-475a-8f7a-67c2b3ccf0e5`
- Head SHA reviewed: `119183e7663b262773482aa76b5d836d13ac94da`
- Source transmission: sent
- Verdict: APPROVE
- Blocking findings: none
- Notes: non-blocking concern about preserving runtime redaction consistency in
  implementation tests; no plan change required. This approval covered the
  listed source hashes before a local commit existed for the planning packet, so
  it is useful evidence but not the final exact-head planning approval.

### GLM

- Job: `job_f3859e03-6b7d-44c9-bba1-15c956ec641c`
- Provider session: `20260528194554404ab841ebe8443a`
- Head SHA reviewed: `119183e7663b262773482aa76b5d836d13ac94da`
- Source transmission: sent
- Verdict: APPROVE
- Blocking findings: none
- Notes: non-blocking concerns about enumerating fallback codes, explicitly
  naming legacy aliases in tests, and pinning export shape during implementation;
  no plan change required. This approval covered the listed source hashes before
  a local commit existed for the planning packet, so it is useful evidence but
  not the final exact-head planning approval.

## Exact-Head Planning Reviews After Kimi Fix

Head SHA reviewed:
`6921027a8cf07082d6c2cbf635886903e718ac4b`

- Claude: job `8398fd91-8c9c-44d2-b957-cda549e6d72c`; source sent;
  subscription OAuth route; verdict APPROVE; no blocking findings.
- Gemini: job `115c1477-e89b-44a2-af50-34d5f1e05bf0`; source sent;
  subscription OAuth route; verdict APPROVE; no blocking findings.
- Grok: job `job_a07757b5-d89d-4268-ae45-08f441241959`; source sent;
  subscription-backed Grok CLI route; verdict APPROVE; no blocking findings.
- DeepSeek: job `job_aeaa59f3-ade3-458a-9aa6-9582685590ff`; source sent;
  direct API route under the existing approval workflow; verdict APPROVE; no
  blocking findings.
- GLM: job `job_d1018edb-4d25-427f-a3b2-09c1db9fed9f`; source sent; direct
  API route under the existing approval workflow; verdict APPROVE; no blocking
  findings.
- Kimi: job `70d699db-523f-4fe1-8b66-abafedec41d4`; source sent after
  explicit large-packet allowance because the packet was 40,699 bytes over
  Kimi's 32,768 byte budget; verdict APPROVE; no blocking findings.

All reviewer routes must follow the same shared route/source-send policy. Do
not introduce an API-vs-subscription approval split in the review evidence.

## Implementation Notes

- Added `plugins/grok/scripts/lib/grok-transport-adapters.mjs` as the Grok
  transport Adapter Module for CLI, web, and auto config facts, prompt budget
  env names, fallback eligibility, safe early-error fallback config, and
  redacted CLI fallback diagnostics.
- Wired `plugins/grok/scripts/grok-web-reviewer.mjs` to consume the Module and
  removed the duplicated inline transport config/fallback helpers.
- Preserved behavior drift guards caught during TDD: web tunnel base URLs keep
  the existing `/api/chat/completions` behavior when `GROK_WEB_BASE_URL` ends in
  `/api`, and CLI fallback diagnostics still include Grok home provenance fields.
- Corrected the planning text to describe source-send handling through the
  shared provider-neutral route/source-send policy, not an API-vs-subscription
  split.

## Local Verification

- `node --test tests/unit/grok-transport-adapters.test.mjs`: PASS, 7 tests.
- `node --test tests/unit/plugin-copies-in-sync.test.mjs`: PASS, 59 tests.
- `npm run smoke:grok`: PASS, 173 tests.
- `npm run lint:sync`: PASS.
- `node --test --experimental-test-coverage tests/unit/grok-transport-adapters.test.mjs`:
  PASS; adapter coverage reported 98.58% lines, 68.00% branches, 100.00%
  functions.
- `node --test --test-name-pattern "coverage baseline tracks every discovered plugin lib file" tests/unit/coverage-script.test.mjs`:
  PASS, 1 test.
- `npm test`: PASS, 2225 tests; 2213 pass, 0 fail, 12 skipped.
- `git diff --check`: PASS.
