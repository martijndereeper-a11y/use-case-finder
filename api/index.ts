import { handle } from 'hono/vercel';
import app from '../src/server.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

export default handle(app);
