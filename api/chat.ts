import type { VercelRequest, VercelResponse } from '@vercel/node';
import { useCases } from '../src/data';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { query } = req.body as { query: string };
    if (!query?.trim()) return res.status(400).json({ error: 'No query' });

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const anthropic = new Anthropic();

    const caseIndex = useCases.map(c =>
      `[${c.id}] ${c.company} | ${c.industry} | ${c.businessType} ${c.marketPosition} | ${(c.countries||[]).join(',')} | Pain: ${c.painPattern} | Objections: ${c.objections.join('; ')} | Result: ${c.result} | Keywords: ${c.keywords.join(', ')}`
    ).join('\n');

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `You are a sales case matcher for WP SEO AI. A deal maker describes their prospect. Pick the 1-3 best matching cases and explain WHY each is relevant in one sentence.

The deal maker says: "${query}"

Available cases:
${caseIndex}

Return ONLY valid JSON array, no markdown:
[{"id": "case-id", "reason": "One sentence why this case fits this prospect"}]

Rules:
- Match on industry, company type, objections, pain pattern, country
- Maximum 3, ranked by relevance
- If no good match, return []`,
      }],
    });

    const text = msg.content[0].type === 'text' ? msg.content[0].text : '[]';
    let matches: Array<{ id: string; reason: string }>;
    try { matches = JSON.parse(text); } catch { matches = []; }

    const results = matches
      .map(m => { const uc = useCases.find(c => c.id === m.id); return uc ? { ...uc, matchReason: m.reason } : null; })
      .filter(Boolean);

    return res.status(200).json({ results });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
