import { defineConfig } from '@playwright/test';
import 'dotenv/config';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const testBaseUrl = process.env.TEST_BASE_URL;
const isRemote = !!testBaseUrl;

if (!testDatabaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL is required for E2E tests. Point it at a dedicated Postgres test database.'
  );
}

const encryptionKey = process.env.ENCRYPTION_KEY || 'timelocknotes-e2e-encryption-key';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: testBaseUrl || 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: isRemote ? undefined : {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      DATABASE_URL: testDatabaseUrl,
      ENCRYPTION_KEY: encryptionKey,
      PORT: '3000',
    },
  },
});
