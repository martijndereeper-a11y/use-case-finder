import { handle } from 'hono/vercel';
import app from '../src/server';

export const config = {
  api: { bodyParser: false },
  maxDuration: 30,
};

export default handle(app);
