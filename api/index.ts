/**
 * Vercel serverless function — handles all /api/* routes.
 * Self-contained: no imports from src/ to avoid bundler issues.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { readFileSync, existsSync } from 'node:fs';
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

const LANGUAGES = ['nl', 'de', 'en'] as const;
type Language = typeof LANGUAGES[number];

interface UseCase {
  id: string;
  company: string;
  domain?: string;
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
  referenceCustomerId?: string;
  language?: Language;
}

function normalizeLanguage(raw: unknown): Language | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'nl' || v === 'de' || v === 'en') return v;
  if (v.startsWith('dutch') || v.startsWith('nederlands')) return 'nl';
  if (v.startsWith('german') || v.startsWith('deutsch')) return 'de';
  if (v.startsWith('english') || v.startsWith('engels')) return 'en';
  return undefined;
}

interface ReferenceCustomer {
  id: string;
  company: string;
  contactName?: string;
  contactEmail?: string;
  successManager: string;
  lastCalled?: string;
  timesCalled: number;
  status: 'active' | 'paused' | 'archived';
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Data loading ────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const GH_REPO = 'martijndereeper-a11y/use-case-finder';
const GH_TOKEN = process.env.GITHUB_TOKEN || '';

function loadSeedCases(): UseCase[] {
  try {
    const raw = readFileSync(join(ROOT, 'use-cases-data.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

let _industriesCache: any = null;
function loadIndustriesData(): any {
  if (_industriesCache) return _industriesCache;
  _industriesCache = JSON.parse(readFileSync(join(ROOT, 'industries-data.json'), 'utf-8'));
  return _industriesCache;
}

/** Load admin-added cases from GitHub repo (data/added-cases.json) */
async function loadAddedCasesFromGitHub(): Promise<UseCase[]> {
  if (!GH_TOKEN) return [];
  try {
    const res = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/data/added-cases.json`, {
      headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json' },
    });
    if (!res.ok) return []; // file doesn't exist yet
    const data = await res.json() as { content: string };
    return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
  } catch { return []; }
}

/** Encode a repo path for the GitHub Contents API: encode each segment but keep the slashes. */
function encodeRepoPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Get the SHA of a file in the repo (needed for updates) */
async function getFileSha(path: string): Promise<string | null> {
  if (!GH_TOKEN) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${encodeRepoPath(path)}`, {
      headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json' },
    });
    if (!res.ok) return null;
    const data = await res.json() as { sha: string };
    return data.sha;
  } catch { return null; }
}

/** Write a file to the GitHub repo */
async function writeToGitHub(path: string, content: string, message: string): Promise<{ ok: boolean; error?: string }> {
  if (!GH_TOKEN) return { ok: false, error: 'No GITHUB_TOKEN' };
  try {
    const sha = await getFileSha(path);
    const body: Record<string, string> = {
      message,
      content: Buffer.from(content).toString('base64'),
    };
    if (sha) body.sha = sha;
    const res = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${encodeRepoPath(path)}`, {
      method: 'PUT',
      headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`writeToGitHub failed: path=${path} status=${res.status} body=${errBody.slice(0, 500)}`);
      return { ok: false, error: `GitHub ${res.status}: ${errBody.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err: any) {
    console.error(`writeToGitHub error: path=${path} err=${err.message}`);
    return { ok: false, error: err.message };
  }
}

/** Upload a PDF to the GitHub repo */
async function uploadPdfToGitHub(filename: string, buffer: Buffer): Promise<{ ok: boolean; error?: string }> {
  if (!GH_TOKEN) return { ok: false, error: 'No GITHUB_TOKEN' };
  try {
    const path = `use-cases/${filename}`;
    const sha = await getFileSha(path);
    const body: Record<string, string> = {
      message: `Add PDF: ${filename}`,
      content: buffer.toString('base64'),
    };
    if (sha) body.sha = sha;
    const res = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${encodeRepoPath(path)}`, {
      method: 'PUT',
      headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`PDF upload failed: filename="${filename}" size=${buffer.length}B status=${res.status} body=${errBody.slice(0, 500)}`);
      return { ok: false, error: `GitHub ${res.status}: ${errBody.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err: any) {
    console.error(`PDF upload error: filename="${filename}" err=${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function loadAllCases(): Promise<UseCase[]> {
  const seed = loadSeedCases();
  const added = await loadAddedCasesFromGitHub();
  const ids = new Set(added.map(c => c.id));
  return [...seed.filter(c => !ids.has(c.id)), ...added];
}

async function saveCase(uc: UseCase): Promise<{ ok: boolean; error?: string }> {
  const added = await loadAddedCasesFromGitHub();
  const idx = added.findIndex(c => c.id === uc.id);
  if (idx >= 0) {
    if (!uc.referenceCustomerId && added[idx].referenceCustomerId) {
      uc.referenceCustomerId = added[idx].referenceCustomerId;
    }
    added[idx] = uc;
  } else added.push(uc);
  return writeToGitHub('data/added-cases.json', JSON.stringify(added, null, 2), `Add case: ${uc.company}`);
}

async function deleteCase(id: string): Promise<{ ok: boolean; error?: string; notFound?: boolean }> {
  const added = await loadAddedCasesFromGitHub();
  const filtered = added.filter(c => c.id !== id);
  if (filtered.length === added.length) return { ok: false, notFound: true };
  return writeToGitHub('data/added-cases.json', JSON.stringify(filtered, null, 2), `Remove case: ${id}`);
}

function slugifyCompany(company: string): string {
  return company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

/**
 * Generate a unique case id, language-aware. Avoids collisions with existing
 * seed and added cases. Pattern: `{slug}-{lang}`, with `-2`, `-3` … suffix on
 * collision. Existing cases keep whatever id they have — never rename on edit.
 */
function generateUniqueId(company: string, language: Language | undefined, existingIds: Set<string>): string {
  const slug = slugifyCompany(company);
  const base = language ? `${slug}-${language}` : slug;
  if (!existingIds.has(base)) return base;
  let n = 2;
  while (existingIds.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Deterministic PDF filename per case — replacements overwrite cleanly via GitHub's SHA-aware PUT. */
function pdfFilenameForCase(caseId: string): string {
  return `${caseId}.pdf`;
}

// ─── Reference Customers storage (GitHub-backed) ────────────────────────────

async function loadReferenceCustomersFromGitHub(): Promise<ReferenceCustomer[]> {
  if (!GH_TOKEN) return [];
  try {
    const res = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/data/reference-customers.json`, {
      headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json' },
    });
    if (!res.ok) return [];
    const data = await res.json() as { content: string };
    return JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
  } catch { return []; }
}

async function saveReferenceCustomersList(list: ReferenceCustomer[], message: string) {
  return writeToGitHub('data/reference-customers.json', JSON.stringify(list, null, 2), message);
}

/** Link/unlink a case to a reference customer in added-cases.json (promotes seed cases when needed). */
async function setCaseReferenceCustomer(caseId: string, refCustomerId: string | null): Promise<{ ok: boolean; error?: string; notFound?: boolean }> {
  const added = await loadAddedCasesFromGitHub();
  let target = added.find(c => c.id === caseId);

  if (!target) {
    const seed = loadSeedCases().find(c => c.id === caseId);
    if (!seed) return { ok: false, notFound: true };
    target = { ...seed };
    added.push(target);
  }
  if (refCustomerId === null) delete target.referenceCustomerId;
  else target.referenceCustomerId = refCustomerId;

  return writeToGitHub('data/added-cases.json', JSON.stringify(added, null, 2), `Link case ${caseId} -> ${refCustomerId || 'none'}`);
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
      const cases = await loadAllCases();
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
      const cases = await loadAllCases();
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
      return res.json({ cases: await loadAllCases() });
    }

    // ── Admin: DELETE /api/admin/cases/:id ──
    const deleteMatch = path.match(/^\/api\/admin\/cases\/(.+)$/);
    if (deleteMatch && req.method === 'DELETE') {
      const id = decodeURIComponent(deleteMatch[1]);
      const result = await deleteCase(id);
      if (result.notFound) return res.status(404).json({ error: 'Case not found or is a seed case' });
      if (!result.ok) return res.status(500).json({ error: result.error || 'Delete failed' });
      return res.json({ ok: true });
    }

    // ── Admin: POST /api/admin/analyze-pdf ──
    if (path === '/api/admin/analyze-pdf' && req.method === 'POST') {
      const { fields, file } = await parseMultipart(req);
      if (!file) return res.status(400).json({ error: 'No PDF file provided' });
      const domain = (fields.domain || '').trim();

      // Parse PDF text (pdf-parse v1 — import lib directly to skip test file)
      const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
      const pdfData = await pdfParse(file.buffer);
      const pdfText = (pdfData.text || '').slice(0, 5000);

      // Fetch website content for richer context
      let siteText = '';
      if (domain) {
        try {
          const url = domain.startsWith('http') ? domain : `https://${domain}`;
          const siteRes = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WPSEOAIBot/1.0)' },
            signal: AbortSignal.timeout(8000),
          });
          if (siteRes.ok) {
            const html = await siteRes.text();
            // Strip HTML tags, scripts, styles — keep text
            siteText = html
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
              .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/&[a-z]+;/gi, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 3000);
          }
        } catch (fetchErr: any) {
          console.warn('Website fetch failed:', fetchErr.message);
        }
      }

      // Keyword-based objection detection
      const suggestedObjections = detectObjections(pdfText);

      // Claude AI extraction — PDF + website context, with retry
      let extracted: Record<string, any> = {};
      const models = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
      try {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const anthropic = new Anthropic();

        const websiteSection = siteText
          ? `\n\nWEBSITE CONTENT (from ${domain}):\n${siteText}`
          : domain
            ? `\n\n(Website ${domain} could not be fetched — extract what you can from the PDF. The domain itself may hint at what the company does.)`
            : '\n\n(No website provided — extract what you can from the PDF only.)';

        const prompt = `You are analyzing a WP SEO AI customer success case. Extract structured data by combining the PDF content with the customer's website to create rich, accurate descriptions.

PDF TEXT (success case slides):
${pdfText}
${websiteSection}

Instructions:
- Use the website to understand what the company does, their market, and their offering
- Use the PDF to understand the SEO challenge, what WP SEO AI did, and the results
- Write the summary from a third-person sales perspective: what the company does, what their challenge was, and what WP SEO AI achieved for them
- The result should be specific and include numbers/metrics from the PDF where possible
- Keywords should help sales reps find this case when preparing for similar prospects

Return ONLY valid JSON, no markdown fences:
{
  "company": "company name",
  "industry": "specific industry in 2-4 words, e.g. Energy / Installation",
  "headline": "compelling one-line headline for this success story",
  "outcome": "short outcome phrase, e.g. +253% organic traffic",
  "result": "1-2 sentence concrete result with numbers from the PDF",
  "summary": "2-3 sentence description: what the company does (from website), their SEO challenge, and what WP SEO AI achieved. Written for a sales rep who needs to quickly understand this case.",
  "businessType": "B2B or B2C or Mix",
  "marketPosition": "Niche or Mainstream",
  "trustSensitive": true or false (medical, legal, finance = true),
  "countries": ["country name(s) where company operates"],
  "keywords": ["8-12 lowercase search keywords covering industry, challenge, solution, and company type"],
  "painPattern": "best matching from: No time / capacity for SEO, Underperforming agency / high SEO cost, AI / LLM search opportunity, Relied on single channel, Lack of control / visibility, Going international / scaling, Efficiency gap, Limited marketing capacity, Other",
  "language": "language of the PDF text — one of: nl (Dutch), de (German), en (English). Look at the actual words in the PDF, not the company location."
}`;

        // Try primary model, fall back to secondary on overload
        let lastError = '';
        for (const model of models) {
          try {
            const msg = await anthropic.messages.create({
              model,
              max_tokens: 1500,
              messages: [{ role: 'user', content: prompt }],
            });
            const responseText = msg.content[0].type === 'text' ? msg.content[0].text : '';
            const jsonStr = responseText.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
            extracted = JSON.parse(jsonStr);
            break; // success
          } catch (modelErr: any) {
            lastError = modelErr.message || String(modelErr);
            console.warn(`Model ${model} failed: ${lastError}`);
            continue; // try next model
          }
        }
        if (Object.keys(extracted).length === 0) {
          extracted = { _error: lastError || 'All models failed' };
        }
      } catch (aiErr: any) {
        console.error('AI extraction failed:', aiErr.message);
        extracted = { _error: aiErr.message };
      }

      return res.json({
        suggestedObjections,
        extracted,
        preview: pdfText.slice(0, 500).trim(),
        websiteFetched: siteText.length > 0,
      });
    }

    // ── Admin: POST /api/admin/cases (create new) ──
    if (path === '/api/admin/cases' && req.method === 'POST') {
      const { fields, file } = await parseMultipart(req);
      const company = (fields.company || '').trim();
      if (!company) return res.status(400).json({ error: 'Company name is required' });
      if (!file) return res.status(400).json({ error: 'PDF file is required' });

      // Parse objections
      const objRaw = fields.objections || '';
      const objections = objRaw ? objRaw.split('|||').filter(o => (OBJECTIONS as readonly string[]).includes(o)) : [];

      // Parse keywords and countries
      const keywords = fields.keywords ? fields.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean) : [];
      const countries = fields.countries ? fields.countries.split(',').map(c => c.trim()).filter(Boolean) : [];

      // Normalize domain
      const rawDomain = (fields.domain || '').trim();
      const domain = rawDomain ? (rawDomain.startsWith('http') ? rawDomain : `https://${rawDomain}`) : undefined;

      // Resolve language (default nl if missing)
      const language = normalizeLanguage(fields.language) || 'nl';

      // Generate id — language-aware, collision-safe across BOTH seed and added cases.
      const existingIds = new Set((await loadAllCases()).map(c => c.id));
      const id = generateUniqueId(company, language, existingIds);
      const pdfFileName = pdfFilenameForCase(id);

      const useCase: UseCase = {
        id,
        company,
        domain,
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
        pdfFile: pdfFileName,
        clickTier: 'Starting near zero (0-100)',
        language,
      };

      // PDF first — if upload fails we don't want orphan metadata pointing at a missing PDF.
      const pdfResult = await uploadPdfToGitHub(pdfFileName, file.buffer);
      if (!pdfResult.ok) {
        return res.status(502).json({ error: `PDF upload to GitHub failed: ${pdfResult.error}. Case was NOT saved.` });
      }

      const caseResult = await saveCase(useCase);
      if (!caseResult.ok) {
        return res.status(502).json({ error: `PDF uploaded but saving case metadata failed: ${caseResult.error}. The PDF is on GitHub but the case will not appear in the finder until this is retried.` });
      }
      return res.json({ ok: true, id: useCase.id, case: useCase });
    }

    // ── Admin: PUT /api/admin/cases/:id (edit existing) ──
    const editMatch = path.match(/^\/api\/admin\/cases\/([^/]+)$/);
    if (editMatch && req.method === 'PUT') {
      const id = decodeURIComponent(editMatch[1]);
      const { fields, file } = await parseMultipart(req);

      // Find the case — could be a seed case (promote on edit) or already in added.
      const added = await loadAddedCasesFromGitHub();
      const existingAdded = added.find(c => c.id === id);
      const existingSeed = existingAdded ? null : loadSeedCases().find(c => c.id === id);
      const existing = existingAdded || existingSeed;
      if (!existing) return res.status(404).json({ error: 'Case not found' });

      const company = (fields.company ?? existing.company).trim() || existing.company;

      // Objections
      const objRaw = fields.objections;
      const objections = objRaw !== undefined
        ? (objRaw ? objRaw.split('|||').filter(o => (OBJECTIONS as readonly string[]).includes(o)) : [])
        : existing.objections;

      // Keywords + countries: only overwrite when the field is present
      const keywords = fields.keywords !== undefined
        ? fields.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
        : existing.keywords;
      const countries = fields.countries !== undefined
        ? fields.countries.split(',').map(c => c.trim()).filter(Boolean)
        : existing.countries;

      // Domain
      let domain = existing.domain;
      if (fields.domain !== undefined) {
        const rawDomain = fields.domain.trim();
        domain = rawDomain ? (rawDomain.startsWith('http') ? rawDomain : `https://${rawDomain}`) : undefined;
      }

      // Language (default to existing)
      const language = normalizeLanguage(fields.language) || existing.language || 'nl';

      // PDF: replace only if a new file was uploaded. Otherwise keep the existing pdfFile reference.
      let pdfFileName = existing.pdfFile;
      if (file) {
        // Upload under deterministic filename for this case id. Overwrites existing if it's already named this way.
        pdfFileName = pdfFilenameForCase(id);
        const pdfResult = await uploadPdfToGitHub(pdfFileName, file.buffer);
        if (!pdfResult.ok) {
          return res.status(502).json({ error: `PDF upload failed: ${pdfResult.error}. Case was NOT updated.` });
        }
      }

      const updated: UseCase = {
        ...existing,
        id, // never change
        company,
        domain,
        industry: (fields.industry ?? existing.industry).trim() || existing.industry,
        painPattern: (fields.painPattern ?? existing.painPattern).trim() || existing.painPattern,
        headline: (fields.headline ?? existing.headline).trim(),
        outcome: (fields.outcome ?? existing.outcome).trim(),
        result: (fields.result ?? existing.result).trim(),
        summary: (fields.summary ?? existing.summary).trim(),
        businessType: fields.businessType || existing.businessType,
        marketPosition: fields.marketPosition || existing.marketPosition,
        trustSensitive: fields.trustSensitive !== undefined ? fields.trustSensitive === 'true' : existing.trustSensitive,
        objections,
        countries,
        keywords,
        pdfFile: pdfFileName,
        language,
        // referenceCustomerId preserved via spread above
      };

      const caseResult = await saveCase(updated);
      if (!caseResult.ok) {
        return res.status(502).json({ error: `Case metadata save failed: ${caseResult.error}. ${file ? 'PDF was uploaded but case did not update.' : ''}` });
      }
      return res.json({ ok: true, id: updated.id, case: updated });
    }

    // ── Admin: Reference Customers ──
    if (path === '/api/admin/reference-customers' && req.method === 'GET') {
      const [customers, cases] = await Promise.all([loadReferenceCustomersFromGitHub(), loadAllCases()]);
      const withCases = customers.map(rc => ({
        ...rc,
        linkedCases: cases
          .filter(uc => uc.referenceCustomerId === rc.id)
          .map(uc => ({ id: uc.id, company: uc.company, industry: uc.industry, pdfFile: uc.pdfFile })),
      }));
      return res.json({ customers: withCases });
    }

    if (path === '/api/admin/reference-customers' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Partial<ReferenceCustomer>;
      const company = (body.company || '').trim();
      if (!company) return res.status(400).json({ error: 'Company name is required' });

      const now = new Date().toISOString();
      const rc: ReferenceCustomer = {
        id: slugifyCompany(company) + '-' + Math.random().toString(36).slice(2, 6),
        company,
        contactName: (body.contactName || '').trim() || undefined,
        contactEmail: (body.contactEmail || '').trim() || undefined,
        successManager: (body.successManager || '').trim(),
        lastCalled: body.lastCalled || undefined,
        timesCalled: typeof body.timesCalled === 'number' ? body.timesCalled : 0,
        status: (body.status as ReferenceCustomer['status']) || 'active',
        notes: (body.notes || '').trim() || undefined,
        createdAt: now,
        updatedAt: now,
      };
      const all = await loadReferenceCustomersFromGitHub();
      all.push(rc);
      const w = await saveReferenceCustomersList(all, `Add reference customer: ${company}`);
      if (!w.ok) return res.status(502).json({ error: w.error || 'GitHub write failed' });
      return res.json({ ok: true, customer: rc });
    }

    const rcIdMatch = path.match(/^\/api\/admin\/reference-customers\/([^/]+)$/);
    if (rcIdMatch && req.method === 'GET') {
      const id = decodeURIComponent(rcIdMatch[1]);
      const rc = (await loadReferenceCustomersFromGitHub()).find(r => r.id === id);
      if (!rc) return res.status(404).json({ error: 'Not found' });
      const cases = (await loadAllCases()).filter(uc => uc.referenceCustomerId === id);
      return res.json({ customer: rc, linkedCases: cases });
    }

    if (rcIdMatch && req.method === 'PUT') {
      const id = decodeURIComponent(rcIdMatch[1]);
      const all = await loadReferenceCustomersFromGitHub();
      const idx = all.findIndex(r => r.id === id);
      if (idx < 0) return res.status(404).json({ error: 'Not found' });
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Partial<ReferenceCustomer>;
      const existing = all[idx];
      const updated: ReferenceCustomer = {
        ...existing,
        company: (body.company ?? existing.company).trim() || existing.company,
        contactName: body.contactName !== undefined ? (body.contactName || '').trim() || undefined : existing.contactName,
        contactEmail: body.contactEmail !== undefined ? (body.contactEmail || '').trim() || undefined : existing.contactEmail,
        successManager: body.successManager !== undefined ? (body.successManager || '').trim() : existing.successManager,
        lastCalled: body.lastCalled !== undefined ? (body.lastCalled || undefined) : existing.lastCalled,
        timesCalled: typeof body.timesCalled === 'number' ? body.timesCalled : existing.timesCalled,
        status: (body.status as ReferenceCustomer['status']) || existing.status,
        notes: body.notes !== undefined ? (body.notes || '').trim() || undefined : existing.notes,
        updatedAt: new Date().toISOString(),
      };
      all[idx] = updated;
      const w = await saveReferenceCustomersList(all, `Update reference customer: ${updated.company}`);
      if (!w.ok) return res.status(502).json({ error: w.error || 'GitHub write failed' });
      return res.json({ ok: true, customer: updated });
    }

    if (rcIdMatch && req.method === 'DELETE') {
      const id = decodeURIComponent(rcIdMatch[1]);
      const all = await loadReferenceCustomersFromGitHub();
      const filtered = all.filter(r => r.id !== id);
      if (filtered.length === all.length) return res.status(404).json({ error: 'Not found' });
      const w = await saveReferenceCustomersList(filtered, `Remove reference customer: ${id}`);
      if (!w.ok) return res.status(502).json({ error: w.error || 'GitHub write failed' });

      // Unlink any cases referencing this id
      const added = await loadAddedCasesFromGitHub();
      let touched = false;
      for (const c of added) {
        if (c.referenceCustomerId === id) { delete c.referenceCustomerId; touched = true; }
      }
      if (touched) await writeToGitHub('data/added-cases.json', JSON.stringify(added, null, 2), `Unlink cases from ${id}`);
      return res.json({ ok: true });
    }

    const rcLogMatch = path.match(/^\/api\/admin\/reference-customers\/([^/]+)\/log-call$/);
    if (rcLogMatch && req.method === 'POST') {
      const id = decodeURIComponent(rcLogMatch[1]);
      const all = await loadReferenceCustomersFromGitHub();
      const idx = all.findIndex(r => r.id === id);
      if (idx < 0) return res.status(404).json({ error: 'Not found' });
      all[idx].timesCalled = (all[idx].timesCalled || 0) + 1;
      all[idx].lastCalled = new Date().toISOString().slice(0, 10);
      all[idx].updatedAt = new Date().toISOString();
      const w = await saveReferenceCustomersList(all, `Log call: ${all[idx].company}`);
      if (!w.ok) return res.status(502).json({ error: w.error || 'GitHub write failed' });
      return res.json({ ok: true, customer: all[idx] });
    }

    const linkMatch = path.match(/^\/api\/admin\/cases\/([^/]+)\/reference-customer$/);
    if (linkMatch && req.method === 'PUT') {
      const caseId = decodeURIComponent(linkMatch[1]);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const target: string | null = body.referenceCustomerId || null;

      if (target) {
        const exists = (await loadReferenceCustomersFromGitHub()).some(r => r.id === target);
        if (!exists) return res.status(404).json({ error: 'Reference customer not found' });
      }
      const result = await setCaseReferenceCustomer(caseId, target);
      if (result.notFound) return res.status(404).json({ error: 'Case not found' });
      if (!result.ok) return res.status(502).json({ error: result.error || 'GitHub write failed' });
      return res.json({ ok: true, caseId, referenceCustomerId: target });
    }

    // ── Public: GET /api/industries ──
    if (path === '/api/industries' && req.method === 'GET') {
      const data = loadIndustriesData();
      return res.json({
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
    }

    // ── Public: POST /api/industries/search ──
    if (path === '/api/industries/search' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const query = (body.query || '').toString();
      if (!query.trim()) return res.status(400).json({ error: 'Query is required' });

      const data = loadIndustriesData();
      const catalog = data.industries
        .map((i: any, idx: number) => `${idx + 1}. ${i.industry} (${i.total_companies} customers)
   Examples: ${i.sample_descriptions.slice(0, 3).join(' | ')}`)
        .join('\n\n');

      const staticBlock = `You are matching a sales rep's free-text search to our customer industry catalog.

Catalog of customer industries (88 total):
${catalog}

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

      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const anthropic = new Anthropic();

      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: staticBlock, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: `Sales rep's search query: "${query}"` },
          ],
        }],
      });

      const responseText = msg.content[0].type === 'text' ? msg.content[0].text : '{}';
      let parsed: any;
      try {
        parsed = JSON.parse(responseText.trim().replace(/^```json\s*/, '').replace(/\s*```$/, ''));
      } catch {
        return res.status(502).json({ error: 'AI returned malformed JSON', raw: responseText.slice(0, 200) });
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

      return res.json({
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
