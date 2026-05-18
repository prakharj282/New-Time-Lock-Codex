import { Pool } from 'pg';

export const E2E_TITLE_PREFIX = '[E2E]';

export function needsSsl(connectionString: string): boolean {
  return /sslmode=require|supabase\.com|pooler\.supabase\.com/i.test(connectionString);
}

export function stripSslMode(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    parsed.searchParams.delete('sslmode');
    return parsed.toString();
  } catch {
    return connectionString.replace(/([?&])sslmode=[^&]+&?/i, '$1');
  }
}

export function createPgPool(connectionString: string): Pool {
  const ssl = needsSsl(connectionString);
  return new Pool({
    connectionString: ssl ? stripSslMode(connectionString) : connectionString,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
  });
}

export function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function withSearchPath(connectionString: string, schema: string): string {
  const parsed = new URL(connectionString);
  parsed.searchParams.set('options', `-c search_path=${schema},public`);
  return parsed.toString();
}

let e2ePool: Pool | null = null;

function getE2ePool() {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) {
    throw new Error('TEST_DATABASE_URL is required for E2E database cleanup.');
  }
  if (!e2ePool) {
    e2ePool = createPgPool(testDatabaseUrl);
  }
  return e2ePool;
}

export async function cleanupE2eNotes(pool = getE2ePool()) {
  await pool.query(
    "DELETE FROM notes WHERE id LIKE 'e2e-%' OR title LIKE $1",
    [`${E2E_TITLE_PREFIX}%`]
  );
}

export async function closeE2eDb() {
  if (e2ePool) {
    await e2ePool.end();
    e2ePool = null;
  }
}
