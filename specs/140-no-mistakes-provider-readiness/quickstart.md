# Quickstart: No-Mistakes Provider Readiness

## Current manual evidence loop

```sh
npm run doctor:cache

tmp=$(mktemp -d /private/tmp/cpm-perfect-smoke-XXXXXX)
mkdir -p "$tmp/fixtures" "$tmp/records"
printf 'export function add(a, b) {\n  return a + b;\n}\n' > "$tmp/fixtures/smoke.js"
git -C "$tmp" init
git -C "$tmp" add fixtures/smoke.js
git -C "$tmp" -c user.name='Codex Smoke' -c user.email='codex-smoke@example.invalid' commit -m 'add smoke fixture'
```

Run provider doctors and source-bearing reviews from installed plugin cache. For direct API providers, run `approval-request` first and pass returned approval token only after approval.

## no-mistakes gate

```sh
git push no-mistakes
no-mistakes
```

Repo config runs:

```sh
npm ci && npm run lint && npm run test:full
```
