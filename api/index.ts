/**
 * Vercel serverless function — handles all /api/* routes.
 * Self-contained: no imports from src/ to avoid bundler issues.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'wpseoai2026';

const OBJECTIONS = [
  'Niche market, too specific for online marketing',
  'B2B sector, nobody searches for our services',
  'Our sector is too technical or complex for AI content',
  'Trust-sensitive sector where mistakes are not allowed',
  'We are too small for this kind of approach',
  'We tried it before and it didn\'t work',
  'It takes too long before you see results',
  'Our customers are not online',
  'We get everything from word of mouth',
  'We already do Google Ads, why also SEO',
] as const;

type Objection = typeof OBJECTIONS[number];

interface UseCase {
  id: string;
  company: string;
  industry: string;
  painPattern: string;
  headline: string;
  outcome: string;
  result: string;
  summary: string;
  businessType: string;
  marketPosition: string;
  trustSensitive: boolean;
  objections: string[];
  clickTier?: string;
  countries: string[];
  keywords: string[];
  pdfFile: string;
}

// ─── Data loading ────────────────────────────────────────────────────────────

const ROOT = process.cwd();

function loadSeedCases(): UseCase[] {
  try {
    const raw = readFileSync(join(ROOT, 'use-cases-data.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function loadAddedCases(): UseCase[] {
  const file = join(ROOT, 'data', 'added-cases.json');
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {}
  return [];
}

function loadAllCases(): UseCase[] {
  const seed = loadSeedCases();
  const added = loadAddedCases();
  const ids = new Set(added.map(c => c.id));
  return [...seed.filter(c => !ids.has(c.id)), ...added];
}

function saveCase(uc: UseCase): void {
  const dir = join(ROOT, 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, 'added-cases.json');
  const added = loadAddedCases();
  const idx = added.findIndex(c => c.id === uc.id);
  if (idx >= 0) added[idx] = uc; else added.push(uc);
  writeFileSync(file, JSON.stringify(added, null, 2), 'utf-8');
}

function deleteCase(id: string): boolean {
  const added = loadAddedCases();
  const filtered = added.filter(c => c.id !== id);
  if (filtered.length === added.length) return false;
  const dir = join(ROOT, 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'added-cases.json'), JSON.stringify(filtered, null, 2), 'utf-8');
  return true;
}

function generateId(company: string): string {
  return company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

// ─── Objection detection ─────────────────────────────────────────────────────

const OBJECTION_PATTERNS: Array<{ objection: Objection; keywords: string[] }> = [
  { objection: 'Niche market, too specific for online marketing', keywords: ['niche', 'specifiek', 'specific', 'te klein', 'small market', 'niche markt', 'specialistisch'] },
  { objection: 'B2B sector, nobody searches for our services', keywords: ['b2b', 'niemand zoekt', 'nobody searches', 'no one searches', 'geen zoekvolume', 'low search volume'] },
  { objection: 'Our sector is too technical or complex for AI content', keywords: ['technisch', 'technical', 'complex', 'ai content', 'expertise', 'specialistisch', 'kennisintensief'] },
  { objection: 'Trust-sensitive sector where mistakes are not allowed', keywords: ['vertrouwen', 'trust', 'medisch', 'medical', 'juridisch', 'legal', 'fouten', 'mistakes', 'compliance', 'regulated'] },
  { objection: 'We are too small for this kind of approach', keywords: ['te klein', 'too small', 'klein bedrijf', 'small business', 'mkb', 'sme', 'kleine onderneming'] },
  { objection: 'We tried it before and it didn\'t work', keywords: ['eerder geprobeerd', 'tried before', 'didn\'t work', 'werkte niet', 'teleurgesteld', 'disappointed', 'bad experience'] },
  { objection: 'It takes too long before you see results', keywords: ['te lang', 'too long', 'duurt lang', 'takes time', 'slow results', 'langzaam', 'geen resultaat', 'no results yet'] },
  { objection: 'Our customers are not online', keywords: ['niet online', 'not online', 'offline', 'klanten zitten niet', 'customers aren\'t online'] },
  { objection: 'We get everything from word of mouth', keywords: ['mond-tot-mond', 'word of mouth', 'referral', 'netwerk', 'network', 'aanbeveling', 'recommendation', 'mond tot mond'] },
  { objection: 'We already do Google Ads, why also SEO', keywords: ['google ads', 'adwords', 'sea', 'advertenties', 'paid search', 'waarom ook seo', 'why also seo', 'already advertis'] },
];

function detectObjections(text: string): Objection[] {
  const t = text.toLowerCase();
  return OBJECTION_PATTERNS.filter(p => p.keywords.some(kw => t.includes(kw))).map(p => p.objection);
}

// ─── Multipart parser (minimal, for PDF upload) ─────────────────────────────

function parseMultipart(req: VercelRequest): Promise<{ fields: Record<string, string>; file?: { name: string; buffer: Buffer } }> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
    if (!match) return reject(new Error('No multipart boundary'));
    const boundary = match[1] || match[2];

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const fields: Record<string, string> = {};
      let file: { name: string; buffer: Buffer } | undefined;

      const boundaryBuf = Buffer.from('--' + boundary);
      const parts: Buffer[] = [];
      let start = 0;

      // Split by boundary
      while (true) {
        const idx = body.indexOf(boundaryBuf, start);
        if (idx === -1) break;
        if (start > 0) parts.push(body.subarray(start, idx - 2)); // -2 for \r\n
        start = idx + boundaryBuf.length + 2; // +2 for \r\n
      }

      for (const part of parts) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const header = part.subarray(0, headerEnd).toString();
        const content = part.subarray(headerEnd + 4);

        const nameMatch = header.match(/name="([^"]+)"/);
        if (!nameMatch) continue;
        const name = nameMatch[1];

        const filenameMatch = header.match(/filename="([^"]+)"/);
        if (filenameMatch) {
          file = { name: filenameMatch[1], buffer: content };
        } else {
          fields[name] = content.toString().trim();
        }
      }

      resolve({ fields, file });
    });
    req.on('error', reject);
  });
}

// ─── Route handler ──────────────────────────────────────────────────────────

export const config = {
  api: { bodyParser: false },
  maxDuration: 30,
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = req.url || '';
  const path = url.split('?')[0];

  try {
    // ── Public: GET /api/use-cases ──
    if (path === '/api/use-cases' && req.method === 'GET') {
      const cases = loadAllCases();
      const painPatterns = [...new Set(cases.map(c => c.painPattern))];
      const industries = [...new Set(cases.map(c => c.industry))];
      const objectionCounts = OBJECTIONS.map(obj => ({
        objection: obj,
        count: cases.filter(c => c.objections.includes(obj)).length,
      }));
      return res.json({ cases, painPatterns, industries, objections: [...OBJECTIONS], objectionCounts });
    }

    // ── Public: GET /api/use-cases/search ──
    if (path === '/api/use-cases/search' && req.method === 'GET') {
      const q = (typeof req.query.q === 'string' ? req.query.q : '').toLowerCase().trim();
      const cases = loadAllCases();
      if (!q) return res.json({ results: cases });

      const terms = q.split(/\s+/);
      const scored = cases.map(uc => {
        const searchable = [uc.company, uc.industry, uc.painPattern, uc.headline, uc.outcome, uc.result, uc.summary, uc.businessType, uc.marketPosition, ...uc.keywords, ...uc.objections, ...(uc.countries || [])].join(' ').toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (searchable.includes(term)) score++;
          if (uc.keywords.some(k => k.includes(term))) score++;
          if (uc.company.toLowerCase().includes(term)) score += 2;
          if (uc.industry.toLowerCase().includes(term)) score += 2;
        }
        return { ...uc, score };
      });
      return res.json({ results: scored.filter(r => r.score > 0).sort((a, b) => b.score - a.score) });
    }

    // ── Admin: POST /api/admin/login ──
    if (path === '/api/admin/login' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.password === ADMIN_PASSWORD) return res.json({ ok: true, token: ADMIN_PASSWORD });
      return res.status(401).json({ error: 'Wrong password' });
    }

    // ── Admin auth check for remaining routes ──
    if (path.startsWith('/api/admin/')) {
      const auth = (req.headers.authorization || '').replace('Bearer ', '');
      if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    }

    // ── Admin: GET /api/admin/cases ──
    if (path === '/api/admin/cases' && req.method === 'GET') {
      return res.json({ cases: loadAllCases() });
    }

    // ── Admin: DELETE /api/admin/cases/:id ──
    const deleteMatch = path.match(/^\/api\/admin\/cases\/(.+)$/);
    if (deleteMatch && req.method === 'DELETE') {
      const id = decodeURIComponent(deleteMatch[1]);
      const ok = deleteCase(id);
      if (!ok) return res.status(404).json({ error: 'Case not found or is a seed case' });
      return res.json({ ok: true });
    }

    // ── Admin: POST /api/admin/analyze-pdf ──
    if (path === '/api/admin/analyze-pdf' && req.method === 'POST') {
      const { file } = await parseMultipart(req);
      if (!file) return res.status(400).json({ error: 'No PDF file provided' });

      // Parse PDF text (pdf-parse v2 API)
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse(new Uint8Array(file.buffer));
      await parser.load();
      const textResult = await parser.getText();
      const text = (textResult.pages || []).map((p: any) => p.text).join('\n').slice(0, 6000);

      // Keyword-based objection detection
      const suggestedObjections = detectObjections(text);

      // Claude AI extraction
      let extracted: Record<string, any> = {};
      try {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const anthropic = new Anthropic();
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
  "industry": "industry in 2-4 words",
  "headline": "one-line headline describing the case",
  "outcome": "short outcome phrase",
  "result": "1-2 sentence concrete result with numbers",
  "summary": "2-3 sentence context about the company, challenge, and what was achieved",
  "businessType": "B2B or B2C or Mix",
  "marketPosition": "Niche or Mainstream",
  "trustSensitive": true/false,
  "countries": ["country name(s)"],
  "keywords": ["5-8 lowercase search keywords"],
  "painPattern": "best matching: No time / capacity for SEO, Underperforming agency / high SEO cost, AI / LLM search opportunity, Relied on single channel, Lack of control / visibility, Going international / scaling, Efficiency gap, Limited marketing capacity, Other"
}`,
          }],
        });
        const responseText = msg.content[0].type === 'text' ? msg.content[0].text : '';
        extracted = JSON.parse(responseText);
      } catch (aiErr: any) {
        console.error('AI extraction failed:', aiErr.message);
        extracted = { _error: aiErr.message };
      }

      return res.json({ suggestedObjections, extracted, preview: text.slice(0, 500).trim() });
    }

    // ── Admin: POST /api/admin/cases ──
    if (path === '/api/admin/cases' && req.method === 'POST') {
      const { fields, file } = await parseMultipart(req);
      const company = (fields.company || '').trim();
      if (!company) return res.status(400).json({ error: 'Company name is required' });
      if (!file) return res.status(400).json({ error: 'PDF file is required' });

      // Save PDF
      const pdfDir = join(ROOT, 'use-cases');
      if (!existsSync(pdfDir)) mkdirSync(pdfDir, { recursive: true });
      writeFileSync(join(pdfDir, file.name), file.buffer);

      // Parse objections
      const objRaw = fields.objections || '';
      const objections = objRaw ? objRaw.split('|||').filter(o => (OBJECTIONS as readonly string[]).includes(o)) : [];

      // Parse keywords and countries
      const keywords = fields.keywords ? fields.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean) : [];
      const countries = fields.countries ? fields.countries.split(',').map(c => c.trim()).filter(Boolean) : [];

      const useCase: UseCase = {
        id: generateId(company),
        company,
        industry: (fields.industry || 'General').trim(),
        painPattern: (fields.painPattern || 'Other').trim(),
        headline: (fields.headline || '').trim(),
        outcome: (fields.outcome || '').trim(),
        result: (fields.result || '').trim(),
        summary: (fields.summary || '').trim(),
        businessType: fields.businessType || 'B2B',
        marketPosition: fields.marketPosition || 'Mainstream',
        trustSensitive: fields.trustSensitive === 'true',
        objections,
        countries,
        keywords,
        pdfFile: file.name,
        clickTier: 'Starting near zero (0-100)',
      };

      saveCase(useCase);
      return res.json({ ok: true, id: useCase.id, case: useCase });
    }

    // ── Health ──
    if (path === '/api/health') {
      return res.json({ ok: true, vercel: true });
    }

    return res.status(404).json({ error: 'Not found' });
  } catch (err: any) {
    console.error('API error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
