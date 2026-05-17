import type { IncomingMessage, ServerResponse } from 'http';
import app, { ensureDatabaseInitialized } from '../server/app';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    await ensureDatabaseInitialized();
    app(req, res);
  } catch (err) {
    console.error('Failed to initialize API:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Server initialization failed' }));
  }
}
