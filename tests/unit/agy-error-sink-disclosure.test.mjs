// PR #218 follow-up #240 (item 1) — decision-level lock for the AGY error-sink disclosure.
//
// agy-read-command-disclosure.test.mjs exercises the gate end-to-end through the CLI, but only the
// pre-spawn / read-command rows are reachable that way: the source-bearing SENT direction
// (latch=true) is produced post-spawn, and round-3's run() finalizer (finalizeRunGitPolicyEscape)
// intercepts the normal post-spawn escape and discloses via classifyExecution — so the generic
// error sinks' latch-override branch is only reachable in the doubly-degraded / non-policy-escape
// corner, which no CI-safe integration path can hit deterministically (a chmod-based wedge does not
// fail as root, the common CI uid). That left the safety-critical row — "a genuinely-sent source is
// ALWAYS disclosed, never omitted or under-warned" — unlocked by any always-run test.
//
// resolveErrorSinkDisclosure is the single source of truth for that decision (lib/job-record.mjs,
// beside classifyExecution); the companion only holds the runtime flags and delegates. These tests
// pin its full truth table directly: deterministic, root-safe, and non-vacuous against any revert of
// the omit rule OR the latch override. They fail if the omit branch widens to swallow a sent source,
// if the latch override is dropped, or if the disclosed value flips.
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveErrorSinkDisclosure } from "../../plugins/agy/scripts/lib/job-record.mjs";

const FIELD = "source_content_transmission";

test("resolveErrorSinkDisclosure: non-read command, pre-spawn -> discloses not_sent", () => {
  // run pre-spawn and continue/resume: no source left the process, but the field must be present
  // and honest (continue fail-closes on this to assert no source was resent).
  const out = resolveErrorSinkDisclosure({ commandOmitsErrorDisclosure: false, sourceSentToTarget: false });
  assert.deepEqual(out, { [FIELD]: "not_sent" });
});

test("resolveErrorSinkDisclosure: non-read command, post-spawn -> discloses sent (the unlocked SENT direction)", () => {
  // run post-spawn reaching the generic sink (fail() doubly-degraded, or main().catch on a
  // non-policy escape): the source already reached the target, so the sink must disclose sent.
  const out = resolveErrorSinkDisclosure({ commandOmitsErrorDisclosure: false, sourceSentToTarget: true });
  assert.deepEqual(out, { [FIELD]: "sent" });
});

test("resolveErrorSinkDisclosure: read/query command, pre-spawn -> omits the field (#240)", () => {
  // status/result/cancel inspect persisted state and transmit nothing; a bare top-level not_sent is
  // misleading, so the field is omitted entirely (the job's real disclosure is nested on the record).
  const out = resolveErrorSinkDisclosure({ commandOmitsErrorDisclosure: true, sourceSentToTarget: false });
  assert.deepEqual(out, {});
  assert.equal(FIELD in out, false, "read-command disclosure must omit the field, not set it to undefined/null");
});

test("resolveErrorSinkDisclosure: latch overrides the omit -> a sent source is ALWAYS disclosed", () => {
  // Defense-in-depth: read commands never set the latch today, but the omit must NEVER swallow a
  // genuinely-sent source. The latch wins over the omit so the failure mode is over-disclosure,
  // never the dangerous under-warning. This row is unreachable via the CLI, so this is its only lock.
  const out = resolveErrorSinkDisclosure({ commandOmitsErrorDisclosure: true, sourceSentToTarget: true });
  assert.deepEqual(out, { [FIELD]: "sent" });
});

test("resolveErrorSinkDisclosure: returns a fresh object each call (no shared mutable singleton)", () => {
  const a = resolveErrorSinkDisclosure({ commandOmitsErrorDisclosure: false, sourceSentToTarget: true });
  const b = resolveErrorSinkDisclosure({ commandOmitsErrorDisclosure: false, sourceSentToTarget: true });
  assert.notEqual(a, b, "each call must return a new object so a caller spreading it cannot mutate shared state");
  assert.deepEqual(a, b);
});
