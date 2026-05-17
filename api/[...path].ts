import type { IncomingMessage, ServerResponse } from 'http';
import app from '../server/app';

export default function handler(req: IncomingMessage, res: ServerResponse) {
  app(req, res);
}
