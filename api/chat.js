const { cases } = require('../lib/cases-data');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    var query = req.body && req.body.query;
    if (!query || !query.trim()) return res.status(400).json({ error: 'No query' });

    var Anthropic = (await import('@anthropic-ai/sdk')).default;
    var anthropic = new Anthropic();

    var caseIndex = cases.map(function(c) {
      return '[' + c.id + '] ' + c.company + ' | ' + c.industry + ' | ' + c.businessType + ' ' + c.marketPosition + ' | ' + (c.countries || []).join(',') + ' | Pain: ' + c.painPattern + ' | Objections: ' + c.objections.join('; ') + ' | Result: ' + c.result + ' | Keywords: ' + c.keywords.join(', ');
    }).join('\n');

    var msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: 'You are a sales case matcher for WP SEO AI. A deal maker describes their prospect. Pick the 1-3 best matching cases and explain WHY each is relevant in one sentence.\n\nThe deal maker says: "' + query + '"\n\nAvailable cases:\n' + caseIndex + '\n\nReturn ONLY valid JSON array, no markdown:\n[{"id": "case-id", "reason": "One sentence why this case fits this prospect"}]\n\nRules:\n- Match on industry, company type, objections, pain pattern, country\n- Maximum 3, ranked by relevance\n- If no good match, return []'
      }],
    });

    var text = msg.content[0].type === 'text' ? msg.content[0].text : '[]';
    var matches;
    try { matches = JSON.parse(text); } catch(e) { matches = []; }

    var results = matches.map(function(m) {
      var uc = cases.find(function(c) { return c.id === m.id; });
      if (!uc) return null;
      return Object.assign({}, uc, { matchReason: m.reason });
    }).filter(Boolean);

    return res.status(200).json({ results: results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
