/**
 * Chat serverless function — Claude-powered case matching
 * Takes a natural language prospect description, returns top matching cases with explanations
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { handle } from 'hono/vercel';
import { useCases } from '../src/data.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

const app = new Hono().basePath('/api/chat');
app.use('*', cors());

// Build a compact case index for the prompt (keep token count low)
function buildCaseIndex(): string {
  return useCases.map(c =>
    `[${c.id}] ${c.company} | ${c.industry} | ${c.businessType} ${c.marketPosition} | ${(c.countries||[]).join(',')} | Pain: ${c.painPattern} | Objections: ${c.objections.join('; ')} | Result: ${c.result} | Keywords: ${c.keywords.join(', ')}`
  ).join('\n');
}

app.post('/match', async (c) => {
  try {
    const { query } = await c.req.json() as { query: string };
    if (!query?.trim()) return c.json({ error: 'No query provided' }, 400);

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const anthropic = new Anthropic();

    const caseIndex = buildCaseIndex();

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `You are a sales case matcher for WP SEO AI. A deal maker describes their prospect. Pick the 1-3 best matching cases and explain WHY each is relevant to this specific prospect in one sentence.

The deal maker says: "${query}"

Available cases:
${caseIndex}

Return ONLY valid JSON array, no markdown:
[{"id": "case-id", "reason": "One sentence why this case is relevant for this prospect"}]

Rules:
- Match on industry similarity, company size/type, objections the prospect likely has, and pain pattern
- If the prospect mentions a specific country, prefer cases from that country
- If no good match exists, return an empty array []
- Maximum 3 matches, ranked by relevance
- The reason should speak to the prospect's situation, not just describe the case`,
      }],
    });

    const responseText = msg.content[0].type === 'text' ? msg.content[0].text : '[]';
    let matches: Array<{ id: string; reason: string }>;
    try {
      matches = JSON.parse(responseText);
    } catch {
      matches = [];
    }

    // Enrich with full case data
    const results = matches
      .map(m => {
        const uc = useCases.find(c => c.id === m.id);
        if (!uc) return null;
        return { ...uc, matchReason: m.reason };
      })
      .filter(Boolean);

    return c.json({ results });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default handle(app);
