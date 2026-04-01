const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'wpseoai2026';

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const path = (req.url || '').replace(/^\/api\/admin\/?/, '').split('?')[0];

  if (path === 'login' && req.method === 'POST') {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) return res.json({ ok: true, token: ADMIN_PASSWORD });
    return res.status(401).json({ error: 'Wrong password' });
  }

  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  return res.status(404).json({ error: 'Not found: ' + path });
}
