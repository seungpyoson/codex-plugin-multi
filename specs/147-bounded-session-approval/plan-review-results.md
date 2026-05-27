# Pre-Implementation Review Results

## Review Packet

- Scope: `specs/147-bounded-session-approval/spec.md`, `plan.md`, `research.md`, `data-model.md`, `quickstart.md`, `evidence-map.md`, `tasks.md`, and `contracts/session-approval-grant.schema.json`
- Initial packet: 8 files, 39,076 bytes, 845 lines
- Source content was sent only to reviewers whose review slot records `source_content_transmission:"sent"`

## Initial Pass

| Reviewer | Job | Source | Verdict | Disposition |
| --- | --- | --- | --- | --- |
| Claude | `4ecfb21a-6947-4e8b-a896-6624c5f5c83f` | sent | APPROVE | Non-blocking comments reconciled before implementation |
| Gemini | `dafb676f-4589-4671-a4d0-d61b948d1d14` | sent | REQUEST_CHANGES | Blocking findings accepted |
| Grok | `job_f541a0d6-7cea-43b0-bf5d-077c04d165e1` | sent | REQUEST_CHANGES | Blocking findings accepted |
| DeepSeek | `job_7a9a41cf-2d3d-4f2d-9fd8-a44f04d0395d` | sent | REQUEST_CHANGES | Blocking finding accepted |
| GLM | `job_a0710921-ba7d-48f7-a1da-27b4d136d1a6` | sent | APPROVE | Non-blocking comments reconciled before implementation |
| Kimi | `5f8d1442-0519-4c8e-b0e1-958efc99441b` | not sent | unusable | Failed before launch with `source_packet_too_large`; does not count |

## Accepted Blocking Findings

- Grant activation proof did not explicitly bind all grant bounds. Remediation: `approval_tuple.grant_bounds` is now part of the canonical grant proof and persisted schema.
- A normal source-bearing approval token or one-time token could be mistaken for a grant activation proof. Remediation: grant request emits `grant_approval_token.value` with `approval_scope:"grant"`, and activation must reject session/once tokens.
- Multiple matching active grants were ambiguous. Remediation: runtime matching must require exactly one matching grant; multiple matches fail closed.
- Schema and data model disagreed about top-level versus nested selected-source/request/route fields. Remediation: those fields now live in `approval_tuple`, and top-level fields are only bound projections.
- `approval_tuple` allowed unknown fields. Remediation: schema now sets `additionalProperties:false` and names the exact tuple shape.
- The plan used a generic `route` field while the runtime token actually binds `selected_route`, `route_step`, `route_steps`, and `fallback_reason`. Remediation: all artifacts now use the runtime field names.
- Missing RED tests for max file/max byte bounds, one-time token activation rejection, owner-only grant file mode, fingerprint recomputation, schema invalid grants, tampered hashes, duplicate activation, and exact `scope_paths:null` semantics. Remediation: `tasks.md` now includes explicit RED/GREEN tasks for each case.
- Grant TTL had no configured maximum. Remediation: the plan now requires a session-approval max TTL config and tests for over-maximum TTL rejection.

## Gate Status

The first review gate did not pass. Implementation did not start.

## Remediated Full-Packet Pass

After remediating the accepted blockers, the full 9-file packet was reviewed by all non-Kimi reviewers:

| Reviewer | Job | Source | Verdict | Disposition |
| --- | --- | --- | --- | --- |
| Claude | `36d95e4b-06b7-43dd-8daa-c37db6cd4159` | sent | APPROVE | Usable |
| Gemini | `1ddc84c1-eb6c-4d73-8f59-d36b0539cc28` | sent | APPROVE | Usable |
| Grok | `job_7214bdb8-9f86-4f54-ab91-b44645c08e77` | sent | APPROVE | Usable |
| DeepSeek | `job_f31afec0-4555-499e-a453-5817e9ba0cb4` | sent | APPROVE | Usable |
| GLM | `job_4d1732c7-461f-4a6e-a740-0e92e652712b` | sent | APPROVE | Usable |

Kimi was split into two shards because Kimi enforces a 32 KiB source-packet cap and the full packet is larger than that. This avoids `--allow-large-source-packet` and keeps source-send policy intact.

| Kimi Shard | Job | Source | Verdict | Disposition |
| --- | --- | --- | --- | --- |
| A: spec, plan, tasks, review results | `3d081b7c-8655-4991-bbb2-d06eb41b84ee` | sent | APPROVE | Usable |
| B: schema, data model, research, quickstart, evidence map | `984eb544-8b96-45f1-acfb-5f102902a2d9` | sent | REQUEST_CHANGES | Blocking canonical JSON finding accepted |

## Canonical JSON Remediation

Kimi shard B found one valid blocker: the artifacts required `approval_fingerprint` to hash stable canonical JSON but did not define the canonicalization algorithm. Remediation added:

- exact `canonicalJson(value)` rules in `plan.md`
- matching canonical JSON validation rules in `data-model.md`
- schema descriptions for `approval_fingerprint` and `approval_tuple`
- explicit timestamp patterns and `grant_session_id` safety constraints
- TDD tasks for canonical JSON determinism, timestamp format, sensitive mismatch diagnostics, and grant-scoped token rejection in normal `run --approval-token`

## Final Kimi Recheck

| Kimi Shard | Job | Source | Verdict | Disposition |
| --- | --- | --- | --- | --- |
| A: spec, plan, tasks, review results | `b4b4bce0-4220-411a-9ee1-9857827ac88e` | sent | APPROVE | Usable |
| B: schema, data model, research, quickstart, evidence map | `e3a052f0-1afd-4364-a7bd-524af4372fb4` | sent | APPROVE | Usable |

## Final Gate Status

Pre-implementation review gate is passed for the planning package. Implementation may start with TDD. Kimi full-packet review remains impossible without explicit large-packet override because the provider cap is 32 KiB; the usable sharded Kimi verdicts are the recorded workaround for this gate.

## Implementation Audit Note

During the first TDD implementation pass, the activation flow was found to be under-specified: `grant_bounds.expires_at` is part of the canonical proof, but activation examples recomputed expiry from `--grant-ttl-ms`, which would change the proof over time. The plan, data model, quickstart, tasks, and evidence map now require activation to reuse the exact `grant_bounds.expires_at` emitted by `approval-grant request`.
