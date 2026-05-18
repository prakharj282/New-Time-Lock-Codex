import 'dotenv/config';

if (!process.env.TEST_BASE_URL) {
  throw new Error('TEST_BASE_URL is required for remote E2E tests.');
}

try {
  const url = new URL(process.env.TEST_BASE_URL);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('TEST_BASE_URL must be an http(s) URL.');
  }
} catch (err) {
  throw new Error(`Invalid TEST_BASE_URL: ${err instanceof Error ? err.message : String(err)}`);
}
