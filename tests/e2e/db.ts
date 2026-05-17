import { Pool } from 'pg';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required for E2E database cleanup.');
}

let pool: Pool | null = null;

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: testDatabaseUrl });
  }
  return pool;
}

export const E2E_TITLE_PREFIX = '[E2E]';

export async function cleanupE2eNotes() {
  await getPool().query(
    "DELETE FROM notes WHERE id LIKE 'e2e-%' OR title LIKE $1",
    [`${E2E_TITLE_PREFIX}%`]
  );
}

export async function closeE2eDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
