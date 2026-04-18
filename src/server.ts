/**
 * Use Case Finder — Standalone server
 * Run: npm run dev
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OBJECTIONS, OBJECTIONS_NL, painPatterns as seedPainPatterns } from './data';
import { loadAllCases, saveCase, deleteCase, generateId, pdfDir, detectObjectionsFromText } from './storage';
import type { UseCase, Objection } from './data';
import { config } from 'dotenv';
config();

let __dirname: string;
try { __dirname = dirname(fileURLToPath(import.meta.url)); } catch { __dirname = process.cwd(); }
const ROOT = process.env.VERCEL ? process.cwd() : join(__dirname, '..');
const app = new Hono();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'wpseoai2026';

app.use('*', cors());

// Login endpoint — validates password, returns token (must be before middleware)
app.post('/api/admin/login', async (c) => {
  const { password } = await c.req.json() as { password: string };
  if (password === ADMIN_PASSWORD) {
    return c.json({ ok: true, token: ADMIN_PASSWORD });
  }
  return c.json({ error: 'Wrong password' }, 401);
});

// Admin auth: check Bearer token on /api/admin/* routes (except login above)
app.use('/api/admin/*', async (c, next) => {
  const auth = c.req.header('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  if (token !== ADMIN_PASSWORD) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});

/** Rebuild derived lists from current cases */
function getDerived() {
  const cases = loadAllCases();
  const painPatterns = [...new Set(cases.map((c) => c.painPattern))];
  const industries = [...new Set(cases.map((c) => c.industry))];
  const objectionCounts = OBJECTIONS.map((obj) => ({
    objection: obj,
    count: cases.filter((c) => c.objections.includes(obj)).length,
  }));
  return { cases, painPatterns, industries, objectionCounts };
}

// ─── Health check ────────────────────────────────────────────────────────────

app.get('/health', (c) => {
  return c.json({ ok: true, root: ROOT, vercel: !!process.env.VERCEL });
});

// ─── Public API ──────────────────────────────────────────────────────────────

app.get('/api/use-cases', (c) => {
  try {
    const { cases, painPatterns, industries, objectionCounts } = getDerived();
    return c.json({ cases, painPatterns, industries, objections: OBJECTIONS, objectionCounts });
  } catch (err: any) {
    return c.json({ error: err.message, stack: err.stack }, 500);
  }
});

app.get('/api/use-cases/search', (c) => {
  const q = (c.req.query('q') || '').toLowerCase().trim();
  const cases = loadAllCases();
  if (!q) return c.json({ results: cases });

  const terms = q.split(/\s+/);

  const scored = cases.map((uc) => {
    const nlTerms = uc.objections.map((o) => OBJECTIONS_NL[o] || '');
    const searchable = [
      uc.company, uc.industry, uc.painPattern, uc.headline,
      uc.outcome, uc.result, uc.summary, uc.businessType, uc.marketPosition,
      ...uc.keywords, ...uc.objections, ...nlTerms, ...(uc.countries || []),
    ].join(' ').toLowerCase();

    let score = 0;
    for (const term of terms) {
      if (searchable.includes(term)) score += 1;
      if (uc.keywords.some((k) => k.includes(term))) score += 1;
      if (uc.company.toLowerCase().includes(term)) score += 2;
      if (uc.industry.toLowerCase().includes(term)) score += 2;
      if (uc.businessType.toLowerCase() === term) score += 2;
      if (uc.objections.some((o) => o.toLowerCase().includes(term))) score += 1;
    }
    return { ...uc, score };
  });

  const results = scored.filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
  return c.json({ results });
});

app.get('/api/use-cases/by-objection', (c) => {
  const obj = c.req.query('objection') || '';
  const results = loadAllCases().filter((uc) => uc.objections.includes(obj as Objection));
  return c.json({ results });
});

// ─── Admin API ───────────────────────────────────────────────────────────────

// Analyze uploaded PDF — extract case details + objections via Claude
app.post('/api/admin/analyze-pdf', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('pdf') as File | null;
    if (!file) return c.json({ error: 'No PDF file provided' }, 400);

    const buffer = Buffer.from(await file.arrayBuffer());

    const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
    const pdfData = await pdfParse(buffer);
    const text = (pdfData.text || '').slice(0, 6000);

    // Keyword-based objection detection (free, instant)
    const suggestedObjections = detectObjectionsFromText(text);

    // Claude-based structured extraction
    let extracted: Record<string, any> = {};
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const anthropic = new Anthropic();
      const objList = OBJECTIONS.map((o, i) => `${i + 1}. ${o}`).join('\n');

      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `Extract structured data from this success case PDF text. Return ONLY valid JSON, no markdown.

PDF text:
${text}

Return this exact JSON structure:
{
  "company": "company name",
  "industry": "industry in 2-4 words, e.g. Healthcare / Medical Staffing",
  "headline": "one-line headline describing the case",
  "outcome": "short outcome phrase, e.g. +253% organic traffic",
  "result": "1-2 sentence concrete result with numbers",
  "summary": "2-3 sentence context about the company, challenge, and what was achieved",
  "businessType": "B2B or B2C or Mix",
  "marketPosition": "Niche or Mainstream",
  "trustSensitive": true/false,
  "countries": ["country name(s) where this company operates"],
  "keywords": ["5-8 lowercase search keywords for finding this case"],
  "painPattern": "best matching pattern from: No time / capacity for SEO, Underperforming agency / high SEO cost, AI / LLM search opportunity, Relied on single channel, Lack of control / visibility, Going international / scaling, Efficiency gap, Limited marketing capacity, Other"
}`,
        }],
      });

      const responseText = msg.content[0].type === 'text' ? msg.content[0].text : '';
      extracted = JSON.parse(responseText);
    } catch (aiErr: any) {
      console.error('AI extraction failed:', aiErr.message);
      extracted = { _error: aiErr.message };
    }

    return c.json({
      suggestedObjections,
      extracted,
      preview: text.slice(0, 500).trim(),
      pageCount: (textResult.pages || []).length,
    });
  } catch (err: any) {
    return c.json({ error: 'Failed to parse PDF: ' + err.message }, 500);
  }
});

// Save new case + PDF
app.post('/api/admin/cases', async (c) => {
  try {
    const formData = await c.req.formData();

    const company = (formData.get('company') as string || '').trim();
    if (!company) return c.json({ error: 'Company name is required' }, 400);

    const pdf = formData.get('pdf') as File | null;
    if (!pdf) return c.json({ error: 'PDF file is required' }, 400);

    // Save PDF to disk
    const pdfFileName = pdf.name;
    const pdfBuffer = Buffer.from(await pdf.arrayBuffer());
    writeFileSync(join(pdfDir, pdfFileName), pdfBuffer);

    // Parse objections (comma-separated string)
    const objectionsRaw = (formData.get('objections') as string || '');
    const objections = objectionsRaw
      ? objectionsRaw.split('|||').filter((o) => OBJECTIONS.includes(o as Objection)) as Objection[]
      : [];

    // Parse keywords
    const keywordsRaw = (formData.get('keywords') as string || '');
    const keywords = keywordsRaw ? keywordsRaw.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean) : [];

    // Parse countries
    const countriesRaw = (formData.get('countries') as string || '');
    const countries = countriesRaw ? countriesRaw.split(',').map((c) => c.trim()).filter(Boolean) : [];

    const useCase: UseCase = {
      id: generateId(company),
      company,
      industry: (formData.get('industry') as string || 'General').trim(),
      painPattern: (formData.get('painPattern') as string || 'Other').trim(),
      headline: (formData.get('headline') as string || '').trim(),
      outcome: (formData.get('outcome') as string || '').trim(),
      result: (formData.get('result') as string || '').trim(),
      summary: (formData.get('summary') as string || '').trim(),
      businessType: (formData.get('businessType') as string || 'B2B') as UseCase['businessType'],
      marketPosition: (formData.get('marketPosition') as string || 'Mainstream') as UseCase['marketPosition'],
      trustSensitive: formData.get('trustSensitive') === 'true',
      objections,
      countries,
      keywords,
      pdfFile: pdfFileName,
      clickTier: 'Starting near zero (0-100)' as UseCase['clickTier'],
    };

    saveCase(useCase);
    return c.json({ ok: true, id: useCase.id, case: useCase });
  } catch (err: any) {
    return c.json({ error: 'Failed to save case: ' + err.message }, 500);
  }
});

// List user-added cases (for admin overview)
app.get('/api/admin/cases', (c) => {
  const cases = loadAllCases();
  return c.json({ cases });
});

// Delete a case
app.delete('/api/admin/cases/:id', (c) => {
  const id = c.req.param('id');
  const ok = deleteCase(id);
  if (!ok) return c.json({ error: 'Case not found or is a seed case' }, 404);
  return c.json({ ok: true });
});

// ─── Industry Search (for AEs) ───────────────────────────────────────────────

let _industriesCache: any = null;
function getIndustriesData() {
  if (_industriesCache) return _industriesCache;
  const path = join(__dirname, 'industries-data.json');
  _industriesCache = JSON.parse(readFileSync(path, 'utf-8'));
  return _industriesCache;
}

app.get('/api/industries', (c) => {
  try {
    const data = getIndustriesData();
    return c.json({
      generated: data.generated,
      total_companies: data.total_companies,
      distinct_industries: data.distinct_industries,
      methodology: data.methodology,
      industries: data.industries.map((i: any) => ({
        industry: i.industry,
        total_companies: i.total_companies,
        finland: i.finland,
        international: i.international,
        sample_descriptions: i.sample_descriptions.slice(0, 5),
      })),
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

app.post('/api/industries/search', async (c) => {
  try {
    const { query } = await c.req.json() as { query: string };
    if (!query || !query.trim()) {
      return c.json({ error: 'Query is required' }, 400);
    }

    const data = getIndustriesData();
    const industryList = data.industries.map((i: any) => ({
      name: i.industry,
      count: i.total_companies,
      samples: i.sample_descriptions.slice(0, 8),
    }));

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const anthropic = new Anthropic();

    const industriesCatalog = industryList
      .map((i: any, idx: number) => `${idx + 1}. ${i.name} (${i.count} customers)
   Examples: ${i.samples.slice(0, 3).join(' | ')}`)
      .join('\n\n');

    const staticBlock = `You are matching a sales rep's free-text search to our customer industry catalog.

Catalog of customer industries (88 total):
${industriesCatalog}

Your task: match the sales rep's query to the most relevant industries from this catalog.

Output format — return ONLY valid JSON (no markdown):
{
  "interpretation": "brief one-line read of what the rep is looking for",
  "matches": [
    {"industry": "exact industry name from catalog", "relevance": "high|medium|low", "why": "one-line reason this matches the query"}
  ]
}

Rules:
- Return 3-8 matches ordered by relevance
- Use the EXACT industry name from the catalog (spelling must match)
- "high" = direct match | "medium" = adjacent/overlapping | "low" = tangential but might be useful
- Be liberal with matches — AEs often describe prospects vaguely
- Include broad matches AND adjacent niches`;

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: staticBlock,
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'text',
            text: `Sales rep's search query: "${query}"`,
          },
        ],
      }],
    });

    const responseText = msg.content[0].type === 'text' ? msg.content[0].text : '{}';
    let parsed: any;
    try {
      parsed = JSON.parse(responseText.trim().replace(/^```json\s*/, '').replace(/\s*```$/, ''));
    } catch {
      return c.json({ error: 'AI returned malformed JSON', raw: responseText.slice(0, 200) }, 502);
    }

    const byName = Object.fromEntries(data.industries.map((i: any) => [i.industry, i]));
    const enriched = (parsed.matches || []).map((m: any) => {
      const full = byName[m.industry];
      if (!full) return null;
      return {
        industry: m.industry,
        relevance: m.relevance,
        why: m.why,
        total_companies: full.total_companies,
        finland: full.finland,
        international: full.international,
        sample_descriptions: full.sample_descriptions.slice(0, 5),
      };
    }).filter(Boolean);

    return c.json({
      query,
      interpretation: parsed.interpretation || '',
      matches: enriched,
      usage: {
        input_tokens: msg.usage?.input_tokens,
        cache_creation_input_tokens: (msg.usage as any)?.cache_creation_input_tokens,
        cache_read_input_tokens: (msg.usage as any)?.cache_read_input_tokens,
        output_tokens: msg.usage?.output_tokens,
      },
    });
  } catch (err: any) {
    return c.json({ error: 'Search failed: ' + err.message }, 500);
  }
});

// ─── Serve PDFs ──────────────────────────────────────────────────────────────

app.get('/use-cases/pdf/:filename', (c) => {
  const filename = decodeURIComponent(c.req.param('filename'));
  const filePath = join(pdfDir, filename);
  if (!existsSync(filePath)) return c.json({ error: 'PDF not found' }, 404);
  const pdf = readFileSync(filePath);
  const mode = c.req.query('download') === '1' ? 'attachment' : 'inline';
  return new Response(pdf, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${mode}; filename="${filename}"`,
    },
  });
});

// ─── Frontend ────────────────────────────────────────────────────────────────

app.get('/', (c) => {
  const html = readFileSync(join(ROOT, 'src', 'dashboard', 'index.html'), 'utf-8');
  return c.html(html);
});

app.get('/admin', (c) => {
  const html = readFileSync(join(ROOT, 'src', 'dashboard', 'admin.html'), 'utf-8');
  return c.html(html);
});

app.get('/industries', (c) => {
  const candidates = [
    join(ROOT, 'src', 'dashboard', 'industries.html'),
    join(__dirname, 'dashboard', 'industries.html'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return c.html(readFileSync(p, 'utf-8'));
    }
  }
  return c.text('industries.html not found', 404);
});

// ─── Export for Vercel ───────────────────────────────────────────────────────

export default app;
