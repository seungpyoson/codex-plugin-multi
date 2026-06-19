// Bounded same-path re-probe for readiness checks (#223).
//
// A readiness probe spawns the provider CLI once and classifies the result.
// A *transient* failure — e.g. an HTTP 401 returned to a non-interactive
// `claude -p` while the Claude CLI is mid-OAuth-token-refresh — would be
// hard-classified terminal by a single-shot probe, even though an immediate
// retry on the SAME auth path would succeed. This helper re-runs the identical
// attempt closure once (after a short backoff) when the first result is
// classified transient, and lets a *reproduced* failure stand as terminal.
//
// It never mutates auth state, credentials, or arguments between attempts —
// that is what distinguishes it from an auth-PATH fallback (which switches
// credentials, e.g. OAuth -> api_key_env). A persistent bad credential fails
// both attempts and remains terminal (fail-closed preserved); a transient
// mid-refresh rejection clears on the second attempt.

const DEFAULT_MAX_ATTEMPTS = 2; // exactly one re-probe
const DEFAULT_BACKOFF_MS = 250;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object}   opts
 * @param {() => Promise<any>} opts.attempt            Runs one probe; returns the execution result.
 * @param {(execution:any) => boolean} opts.isTransientFailure  True iff the result is a retryable transient.
 * @param {number}   [opts.maxAttempts]  Total attempts including the first (>=1). Default 2 (one re-probe).
 * @param {number}   [opts.backoffMs]    Delay before the re-probe. Default 250ms.
 * @param {(ms:number) => Promise<void>} [opts.sleep]  Injectable for tests.
 * @returns {Promise<any>} The last execution result (success, or the reproduced/terminal failure).
 */
export async function probeWithReprobe({
  attempt,
  isTransientFailure,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  backoffMs = DEFAULT_BACKOFF_MS,
  sleep = defaultSleep,
} = {}) {
  if (typeof attempt !== "function") {
    throw new Error("probeWithReprobe: attempt must be a function");
  }
  if (typeof isTransientFailure !== "function") {
    throw new Error("probeWithReprobe: isTransientFailure must be a function");
  }
  const total = Number.isInteger(maxAttempts) && maxAttempts >= 1 ? maxAttempts : DEFAULT_MAX_ATTEMPTS;
  let execution;
  for (let i = 1; i <= total; i++) {
    execution = await attempt();
    if (i >= total) break;
    if (!isTransientFailure(execution)) break;
    if (backoffMs > 0) await sleep(backoffMs);
  }
  return execution;
}
