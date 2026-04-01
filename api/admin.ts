import type { VercelRequest, VercelResponse } from '@vercel/node';
import { OBJECTIONS } from '../src/data';
import { detectObjectionsFromText } from '../src/storage';
import type { Objection } from '../src/data';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'wpseoai2026';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = 'martijndereeper-a11y/use-case-finder';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const path = (req.url || '').replace(/^\/api\/admin\/?/, '').split('?')[0];

  // Login (no auth required)
  if (path === 'login' && req.method === 'POST') {
    const { password } = req.body as { password: string };
    if (password === ADMIN_PASSWORD) return res.json({ ok: true, token: ADMIN_PASSWORD });
    return res.status(401).json({ error: 'Wrong password' });
  }

  // Auth check for everything else
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });

  // Analyze PDF
  if (path === 'analyze-pdf' && req.method === 'POST') {
    try {
      // For multipart form data, Vercel parses it differently
      // We need to handle the raw body
      return res.status(200).json({
        error: 'PDF analysis requires the local admin panel (npm run dev). Use it locally to scan PDFs, then save to deploy.'
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Save case via GitHub API
  if (path === 'cases' && req.method === 'POST') {
    if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN not configured' });
    try {
      return res.status(200).json({ error: 'Case saving via GitHub API - use local admin for now' });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(404).json({ error: 'Not found' });
}
