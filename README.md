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

## End-To-End Tests

E2E tests use a dedicated Postgres database and delete only notes whose IDs or titles are marked for E2E.

```sh
TEST_DATABASE_URL=postgres://user:password@host:5432/timelocknotes_test
ENCRYPTION_KEY=replace-with-a-long-random-secret
npm run test:e2e
```

PowerShell:

```powershell
$env:TEST_DATABASE_URL="postgres://user:password@host:5432/timelocknotes_test"
$env:ENCRYPTION_KEY="replace-with-a-long-random-secret"
npm run test:e2e
```

Do not point `TEST_DATABASE_URL` at production data.

## Production Build

```sh
npm run build
npm start
```

`npm start` serves the built `dist` frontend and the Express API from one local Node process.

## Vercel Deployment

Vercel serves the built Vite app from `dist` and runs the Express API through `api/[...path].ts`.

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
