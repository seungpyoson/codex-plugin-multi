# Research: Grok CLI-Primary Transport Parity

## Decision: Keep CLI primary and web fallback behavior unchanged

**Rationale**: Current code and #176 evidence show CLI primary and auto fallback
already exist. The risk is not missing behavior; it is scattered transport
knowledge.

**Alternatives considered**:

- Rebuild Grok around the CLI only. Rejected because explicit web tunnel support
  is still a valid subscription-backed fallback and repair path.
- Treat web fallback as policy-level provider fallback. Rejected because #171
  requires shared policy to consume Adapter capability facts, not Grok-specific
  policy branches.

## Decision: Introduce a Grok transport Adapter Module

**Rationale**: One Module can make CLI and web transport facts explicit:
transport id, provider id, display name, auth mode, selected route,
configuration defaults, prompt-budget cap name, and fallback diagnostics. That
increases locality and gives tests a smaller Interface to exercise.

**Alternatives considered**:

- Leave all behavior in `grok-web-reviewer.mjs` and add comments. Rejected
  because comments do not create a seam or reduce review surface.
- Split the entire reviewer runtime. Rejected for this slice because it would
  increase blast radius and make behavior preservation harder to prove.

## Decision: Keep launch mechanics in the existing runtime for this slice

**Rationale**: Moving process spawn, prompt-file lifecycle, web fetch, tunnel
startup, JobRecord building, and review-quality handling at the same time would
turn #159 into a broad rewrite. The first deepening slice should concentrate the
transport Interface while preserving runtime mechanics.

**Alternatives considered**:

- Move all CLI and web launch code into separate files. Rejected as too broad for
  the first TDD slice.
- Build a generic provider transport abstraction shared by all providers now.
  Rejected because #171 already owns shared provider policy, and #159 is a Grok
  Adapter architecture issue.

## Decision: Plan review before implementation

**Rationale**: The saved goal explicitly blocks implementation until the
investigation, Speckit plan/tasks, and unanimous external adversarial plan
review are complete.

**Alternatives considered**:

- Start with a harmless refactor and review after. Rejected because this task is
  specifically about avoiding symptom-first patching.
