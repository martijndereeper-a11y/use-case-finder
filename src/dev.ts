import { serve } from '@hono/node-server';
import app from './server.js';

const port = parseInt(process.env.PORT || '3001');
console.log(`Use Case Finder running at http://localhost:${port}`);
console.log(`Admin panel at http://localhost:${port}/admin`);
serve({ fetch: app.fetch, port });
