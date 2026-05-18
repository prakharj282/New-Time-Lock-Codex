import app from '../server/app';

async function main() {
  delete process.env.DATABASE_URL;
  delete process.env.ENCRYPTION_KEY;

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not start route smoke server');
  }

  try {
    for (const path of ['/api/health', '/api/notes']) {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
      const body = await response.text();

      if (response.status === 404) {
        throw new Error(`${path} returned 404. /api routes are not reaching the Express app.`);
      }

      console.log(`${path} ${response.status} ${body}`);
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()));
    });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
