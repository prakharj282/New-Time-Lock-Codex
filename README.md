# TimeLock Notes

TimeLock Notes is a Vite + React app with an Express API backed by PostgreSQL. The API encrypts note content with AES-256-GCM before storing it.

## Local Development

Export these variables before starting the server:

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
