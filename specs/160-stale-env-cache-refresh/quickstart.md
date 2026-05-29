# Quickstart: Refresh-Aware Direct API Credentials

## Scenario 1: Doctor Uses Refreshed Cache Over Stale Env

1. Create an owner-only cache file at `~/.cache/op/env.sh` or set
   `API_REVIEWERS_ENV_CACHE` to an owner-only test file.
2. Put `export DEEPSEEK_API_KEY="new-key"` in the cache.
3. Run doctor with `DEEPSEEK_API_KEY=old-key` in process env and cache enabled.
4. Confirm the provider receives `Bearer new-key`.
5. Confirm doctor JSON reports:
   - `credential_ref: "DEEPSEEK_API_KEY"`
   - `credential_source: "env_cache"`
6. Confirm neither key value appears in stdout/stderr.

## Scenario 2: No Cache Falls Back To Env

1. Run doctor with no cache file.
2. Set `DEEPSEEK_API_KEY=env-key`.
3. Confirm the provider receives `Bearer env-key`.
4. Confirm doctor JSON reports `credential_source: "env"`.

## Scenario 3: Approval Auth Path Tracks Source

1. Request source-send approval with an env-sourced credential.
2. Refresh cache so the same credential ref resolves from cache.
3. Confirm the auth path changes from `credential_source: "env"` to
   `credential_source: "env_cache"` and stale approval does not silently match.

## Scenario 4: Claude Session Limit Does Not Retry Permission Modes

1. Run a Claude source-bearing custom review against a fixture that returns
   `You've hit your session limit`.
2. Confirm the JobRecord reports `error_code: "usage_limited"`.
3. Confirm only the first permission mode was attempted.
4. Confirm the selected source was not resent through the remaining permission
   modes.

## Scenario 5: Same-Provider Source-Bearing Work Is Admitted Once

1. Start one source-bearing review for a provider.
2. Start a second source-bearing review for the same provider before the first
   exits.
3. Confirm the second JobRecord reports `provider_workload_blocked` and
   `payload_sent:false`.
4. Confirm a source-free doctor/ping or a different provider is not blocked by
   that lease.

## Scenario 6: OAuth Account Identity Is Pseudonymous

1. Run Claude doctor or a source-bearing Claude review with OAuth auth status
   returning account fields.
2. Confirm output includes `account_fingerprint.algorithm: "sha256"` and a
   64-character hex fingerprint.
3. Confirm raw email, account, user, and org values do not appear in stdout,
   stderr, or persisted JobRecords.
