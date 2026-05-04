# Grok Subscription Tunnel Runbook

The Grok plugin uses a local subscription-backed web tunnel by default. The
plugin talks to a local OpenAI-compatible endpoint and the tunnel talks to Grok
with the user's browser/session state. This avoids paid API fallback and keeps
the Grok path tied to the user's subscription.

## Compatible Tunnels

Known compatible shapes:

- `chenyme/grok2api`: recommended default. It exposes
  `http://127.0.0.1:8000/v1`, `GET /v1/models`, and
  `POST /v1/chat/completions`. The plugin default model is
  `grok-4.20-fast`, which works with basic account pools and can be overridden
  with `GROK_WEB_MODEL`.
- `TheSethRose/Grok3-Tunnel`: exposes `http://127.0.0.1:11435/api`,
  `GET /api/models`, and `POST /api/chat/completions`.
- `klu-ai/swift-grok`: includes an OpenAI-compatible proxy mode and a CLI that
  can extract or import Grok cookies.

Other tunnels can work if they provide:

- `GET <GROK_WEB_BASE_URL>/models` for readiness.
- `POST <GROK_WEB_BASE_URL>/chat/completions` with OpenAI-compatible
  `model`, `messages`, and non-streaming `choices[0].message.content`.
- Optional `Authorization: Bearer <value>` support when
  `GROK_WEB_TUNNEL_API_KEY` is set.

## grok2api Setup

1. Start from a logged-in Grok browser session.
2. Install and start grok2api according to that project's local or Docker
   Compose instructions.
3. On macOS Chrome-family browsers, sync the local Grok web session into
   grok2api:

```sh
npm run grok:sync-browser-session
```

The helper announces which local browser profile and cookie database it reads,
may trigger macOS Keychain access, prefers the `sso-rw` cookie over `sso`, and
prints only sanitized pool/quota status. It adds and refreshes the new token
before deleting old grok2api accounts in the same target pool, so an
add/refresh failure does not empty the existing pool and accounts in other pools
are preserved. Pass `--append` to keep existing accounts in the target pool too.
If deleting stale grok2api tokens fails after the new token is imported, the
failure JSON reports `stale_token_count` so operators know the pool still
contains old entries. It defaults the local pool to `super` because grok2api may
misclassify SuperGrok sessions as `basic` during quota auto-detection.

Useful options:

```sh
npm run grok:sync-browser-session -- --browser chrome --profile Default --pool super
npm run grok:sync-browser-session -- --browser brave --profile Default --pool super
npm run grok:sync-browser-session -- --browser edge --profile Default --pool super
npm run grok:sync-browser-session -- --browser arc --profile Default --pool super
npm run grok:sync-browser-session -- --browser chrome --profile Default --pool super --append
```

The helper talks to grok2api's local admin API with
`GROK2API_ADMIN_KEY` or `--admin-key`. The out-of-box grok2api default is
`grok2api`; use a custom admin key if grok2api is bound anywhere other than
loopback or is running on a shared host. `GROK2API_ADMIN_TIMEOUT_MS` or
`--admin-timeout-ms` controls the per-call admin API timeout.

4. If browser extraction fails, configure grok2api with your Grok web account
   token/session in grok2api's own local config or admin UI, or pass a local
   JSON file with `--cookie-source-json` containing `{ "name": "sso-rw",
   "value": "..." }` or `{ "name": "sso", "value": "..." }` entries. Keep
   that state outside this repository. This JSON escape hatch is also the
   fallback if a future Chrome cookie format cannot be decrypted by the helper.
5. Keep the plugin endpoint at the default, or set:

```sh
export GROK_WEB_BASE_URL=http://127.0.0.1:8000/v1
```

6. If grok2api requires an API key for `/v1/*`, set that key in the shell
   environment that launches Codex or the test command:

```sh
export GROK_WEB_TUNNEL_API_KEY='grok2api-local-api-key'
```

## Grok3-Tunnel Setup

1. Start from a logged-in Grok browser session.
2. Extract the minimum cookie string required by the tunnel. Grok3-Tunnel
   documents `sso` and `sso-rw` as the minimum cookie names.
3. Start the local tunnel according to that project's instructions.
4. Override the plugin endpoint:

```sh
export GROK_WEB_BASE_URL=http://127.0.0.1:11435/api
```

5. If the tunnel expects the cookie string as a bearer value, set it in the
   shell environment that launches Codex or the test command:

```sh
export GROK_WEB_TUNNEL_API_KEY='sso=...; sso-rw=...'
```

Do not paste cookie values, bearer tokens, `sso`, `sso-rw`, or full cURL
headers into chat, issue comments, test output, or JobRecords. The plugin only
prints `credential_ref: "GROK_WEB_TUNNEL_API_KEY"` when a bearer value is
present.

## Verify

Readiness:

```sh
node plugins/grok/scripts/grok-web-reviewer.mjs doctor
```

Expected readiness:

- `provider: "grok-web"`
- `auth_mode: "subscription_web"`
- `ready: true`
- `reachable: true`
- `probe_endpoint` ending in `/models`

Live E2E:

```sh
GROK_LIVE_E2E=1 npm run e2e:grok
```

Expected E2E result:

- The test completes.
- The JobRecord has `status: "completed"`.
- `external_review.source_content_transmission` is `"sent"`.
- Secret values are not printed.

If readiness returns `tunnel_unavailable`, start or repair the local Grok web
tunnel and retry.

Review runs persist a redacted JobRecord under
`GROK_PLUGIN_DATA` or `.codex-plugin-data/grok`. The helper can inspect that
local state without contacting Grok. `list` returns the recent local index, with
the newest job first; `result` reads a specific per-job record:

```sh
node plugins/grok/scripts/grok-web-reviewer.mjs list
node plugins/grok/scripts/grok-web-reviewer.mjs result --job-id <job_id>
```

Custom and branch-diff scope reads reject unsafe paths and files larger than
256 KiB before contacting the local tunnel. Split larger reviews into smaller
`--scope-paths` bundles.
