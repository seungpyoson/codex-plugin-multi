# Review Enforcement

This repository does not use manually relayed external-review comments as a
merge gate. External reviewers must run through the plugin reviewers so their
findings, runtime failures, and follow-up fixes stay inside the repo workflow
instead of being copied into ad hoc PR comments.

Plugin reviewer output is an advisory signal for maintainers. Blocking findings
from Claude, Gemini, Kimi, Grok, DeepSeek, GLM, Greptile, or another reviewer
must be addressed with normal commits and verified by CI before merge.

## Required Branch Protection

Repo settings must configure these as required status checks on `main`. The
active `CI gates` ruleset uses the raw check/status context names below:

- `lint`
- `test`
- `smoke (api-reviewers)`
- `smoke (claude)`
- `smoke (gemini)`
- `smoke (grok)`
- `smoke (kimi)`
- `SonarCloud Code Analysis`

Repo settings must also set:

- required approving review count: 1
- require conversation resolution: true
- dismiss stale reviews on push: true
- require last push approval: true, when the repository plan supports it

Without those GitHub settings, CI remains visible but is not a hard merge gate.
Bot reviews such as Greptile are useful advisory signals, but they do not
replace the required human approving review.
