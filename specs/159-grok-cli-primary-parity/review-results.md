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

Implementation remains blocked. The initial committed planning packet at
`91e2dac5d898e030a279d7c5d4a69ceb21df547c` received usable approvals from
DeepSeek, GLM, Claude, Gemini, and Grok, but Kimi returned a blocking contract
finding. The contract and task list were updated to address that finding, so the
required six-reviewer gate must be rerun against the next committed head before
implementation starts.

The prior exact-head JobRecords are useful audit evidence only. They do not
approve the patched packet because the review surface changed.

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

## Pending Planning Reviews

- DeepSeek: pending fresh exact-head rerun after local planning commit.
- GLM: pending fresh exact-head rerun after local planning commit.
- Claude: pending explicit operator approval to send planning packet.
- Gemini: pending explicit operator approval to send planning packet.
- Grok: pending explicit operator approval to send planning packet.
- Kimi: pending explicit operator approval to send planning packet.
