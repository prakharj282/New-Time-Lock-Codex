# TimeLock Notes

TimeLock Notes is a Vite + React app with an Express API backed by PostgreSQL. The API encrypts note content with AES-256-GCM before storing it.

## Local Development

Copy `.env.example` to `.env` and set these variables before starting the server:

```sh
DATABASE_URL=postgres://user:password@host:5432/database
ENCRYPTION_KEY=replace-with-a-long-random-secret
```

Run the app:

```sh
npm install
npm run dev
```

The React app runs on `http://localhost:5173` and proxies `/api/*` to the local Express server on port `3000`.

You can verify the API is ready at `http://localhost:5173/api/health`.

If the app shows `API route not found (404)`, the frontend is running without the Express API. Use `npm run dev`, `npm start`, or `npm run preview`; do not serve `dist` with a static-only server.

## Accountability Partner Access

Open **Partner** in the main-page header to create one invitation. Copy and send it before closing the panel. The partner sets their own six-digit PIN on the separate `/partner` page and enters it on each new visit. They can change their PIN using their current PIN.

To enable **Replace partner link**, set the server-only `PARTNER_MANAGEMENT_KEY` to a strong random secret of at least 32 characters. Keep it private and enter it when replacing the link. Replacement immediately invalidates the old link and partner sessions. The partner sets a new PIN from the replacement link.

Partner invitation secrets stay in the URL fragment, PINs are stored only as salted `scrypt` hashes, and partner sessions use hashed random tokens in strict `HttpOnly` cookies. Unlocking a scheduled note bypasses only its current active window and leaves future recurrence enabled.

The main application and its legacy APIs remain public by design. Partner access is an emergency workflow, not an authentication boundary for the owner application or database.

## Automated Tests

Automated tests use a dedicated Postgres database and delete only notes whose IDs or titles are marked for E2E.

```sh
TEST_DATABASE_URL=postgres://user:password@host:5432/timelocknotes_test
ENCRYPTION_KEY=replace-with-a-long-random-secret
npm run test:all
```

PowerShell:

```powershell
$env:TEST_DATABASE_URL="postgres://user:password@host:5432/timelocknotes_test"
$env:ENCRYPTION_KEY="replace-with-a-long-random-secret"
npm run verify:release
```

Do not point `TEST_DATABASE_URL` at production data.

See [docs/TESTING.md](docs/TESTING.md) for the local, Vercel Preview, and production smoke test gates.

## Production Build

```sh
npm run build
npm run preview
```

`npm run preview` builds the frontend and serves the built `dist` frontend plus the Express API from one local Node process.

## Vercel Deployment

Vercel serves the built Vite app from `dist` and routes `/api/*` to the Express API through `api/index.ts`.

Use these Vercel settings:

- Framework preset: `Vite`
- Build command: `npm run build`
- Output directory: `dist`
- Install command: `npm install`
- Start command: leave blank

Add these environment variables in Vercel:

- `DATABASE_URL`
- `ENCRYPTION_KEY`

For Capacitor builds that should load a deployed web URL, set `CAPACITOR_SERVER_URL`. Leave it unset to use the bundled `dist` assets.
