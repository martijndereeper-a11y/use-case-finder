const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'wpseoai2026';

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // The rewrite sends /api/admin/login -> /api/admin but preserves the original URL in req.url
  var url = req.url || '';
  var path = url.replace(/^\/api\/admin\/?/, '').split('?')[0];

  // Login
  if ((path === 'login' || url.endsWith('/login')) && req.method === 'POST') {
    var password = req.body && req.body.password;
    var envPw = ADMIN_PASSWORD;
    if (password === envPw) return res.json({ ok: true, token: envPw });
    return res.status(401).json({ error: 'Wrong password' });
  }

  var auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  return res.status(404).json({ error: 'Not found' });
};
