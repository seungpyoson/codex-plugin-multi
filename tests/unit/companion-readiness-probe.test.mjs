import test from "node:test";
import assert from "node:assert/strict";

import { probeWithReprobe } from "../../plugins/claude/scripts/lib/companion-readiness-probe.mjs";

// Drives a scripted sequence of attempt results and records how many times the
// attempt closure ran. The last scripted result repeats if more attempts occur.
function scriptedAttempts(results) {
  let i = 0;
  const calls = [];
  return {
    calls,
    attempt: async () => {
      const r = results[Math.min(i, results.length - 1)];
      i += 1;
      calls.push(r);
      return r;
    },
  };
}

test("re-probes once and returns success when a transient clears on the second attempt", async () => {
  const { attempt, calls } = scriptedAttempts([
    { exitCode: 1, transient: true },
    { exitCode: 0, transient: false },
  ]);
  const sleeps = [];
  const result = await probeWithReprobe({
    attempt,
    isTransientFailure: (ex) => ex.transient === true,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [250]); // exactly one backoff before the single re-probe
});

test("a reproduced transient becomes terminal after exactly one re-probe (bounded)", async () => {
  const { attempt, calls } = scriptedAttempts([
    { exitCode: 1, transient: true },
    { exitCode: 1, transient: true },
    { exitCode: 1, transient: true },
  ]);
  let sleepCount = 0;
  const result = await probeWithReprobe({
    attempt,
    isTransientFailure: (ex) => ex.transient === true,
    sleep: async () => { sleepCount += 1; },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(calls.length, 2); // never exceeds maxAttempts even when always transient
  assert.equal(sleepCount, 1);
});

test("a terminal (non-transient) failure is never retried — fail-closed preserved", async () => {
  const { attempt, calls } = scriptedAttempts([
    { exitCode: 1, transient: false },
    { exitCode: 0, transient: false },
  ]);
  let sleepCount = 0;
  const result = await probeWithReprobe({
    attempt,
    isTransientFailure: (ex) => ex.transient === true,
    sleep: async () => { sleepCount += 1; },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(calls.length, 1);
  assert.equal(sleepCount, 0);
});

test("a first-attempt success neither retries nor sleeps", async () => {
  const { attempt, calls } = scriptedAttempts([{ exitCode: 0, transient: false }]);
  let sleepCount = 0;
  const result = await probeWithReprobe({
    attempt,
    // Realistic predicate: only a non-zero exit can be transient. A success is
    // therefore never re-probed regardless of other fields.
    isTransientFailure: (ex) => ex.exitCode !== 0,
    sleep: async () => { sleepCount += 1; },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(sleepCount, 0);
});

test("honors a custom maxAttempts while staying bounded", async () => {
  const { attempt, calls } = scriptedAttempts([
    { exitCode: 1, transient: true },
    { exitCode: 1, transient: true },
    { exitCode: 0, transient: false },
  ]);
  const result = await probeWithReprobe({
    attempt,
    isTransientFailure: (ex) => ex.transient === true,
    maxAttempts: 3,
    sleep: async () => {},
  });
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 3);
});

test("validates its callbacks", async () => {
  await assert.rejects(
    () => probeWithReprobe({ isTransientFailure: () => false }),
    /attempt must be a function/,
  );
  await assert.rejects(
    () => probeWithReprobe({ attempt: async () => ({}) }),
    /isTransientFailure must be a function/,
  );
});
