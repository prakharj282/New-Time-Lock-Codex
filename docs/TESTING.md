# Automated Verification

This app uses three automated layers before a release is trusted:

- Unit tests for pure lock, schedule, time, gibberish, and error-message rules.
- API/integration tests for Express, PostgreSQL schema setup, encryption-at-rest, lock persistence, emergency flows, schedules, photo JSON, and time state.
- Playwright E2E tests for the browser flows users actually click.

## Required Test Environment

Use a dedicated Supabase/Postgres test database for destructive checks.

```powershell
$env:TEST_DATABASE_URL="postgres://..."
$env:ENCRYPTION_KEY="same-stable-test-key-used-by-preview"
```

Do not point `TEST_DATABASE_URL` at production data. Tests only clean rows whose IDs start with `e2e-` or titles start with `[E2E]`, but the API suite also creates an isolated temporary schema to test schema initialization and migration behavior.

## Local Release Gate

```powershell
npm run build
npm run lint
npm run test:unit
npm run test:api
npm run test:e2e
npm run test:all
```

`npm run verify:release` runs the build, lint, route smoke, unit, API, and local E2E checks.

## Vercel Preview Gate

Configure the Vercel Preview environment with:

- `DATABASE_URL`: the dedicated Supabase/Postgres test database URL
- `ENCRYPTION_KEY`: the same stable test key used locally

Then run:

```powershell
$env:TEST_DATABASE_URL="postgres://..."
$env:ENCRYPTION_KEY="same-stable-test-key-used-by-preview"
$env:TEST_BASE_URL="https://your-vercel-preview-url.vercel.app"
npm run test:e2e:remote
```

When `TEST_BASE_URL` is set, Playwright does not start a local server. It tests the deployed preview URL directly and fails if `/api/health` or `/api/notes` routes as `404`.

## Production Smoke

Production checks should stay non-destructive unless explicitly approved:

```powershell
curl https://your-production-url.vercel.app/api/health
curl https://your-production-url.vercel.app/api/notes
```

Expected:

- `/api/health` returns `200` with `{ "ok": true, "database": "connected" }`
- `/api/notes` does not return `404`
- no automated production test creates, edits, locks, or deletes user notes

## Current Coverage

- Save, reload, edit, delete
- Duration, date/time, always, current schedule, off-window schedule, multi-slot schedule
- Locked content hidden and preserved
- Locked title update through the title endpoint
- Emergency unlock typed text
- Emergency Open success and quota exhaustion
- Photo note save/reload/thumbnail/hide-when-locked behavior
- API failures shown inline instead of blank screens
- Supabase starter-table migration
- AES-GCM encrypted note content at rest
- List API never returns decrypted note body
- Vercel/API route smoke for `404` regressions
