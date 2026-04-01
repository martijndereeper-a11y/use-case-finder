import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Test: does the function even run?
  try {
    const { useCases } = await import('../src/data');
    return res.status(200).json({ ok: true, caseCount: useCases.length });
  } catch (err: any) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
