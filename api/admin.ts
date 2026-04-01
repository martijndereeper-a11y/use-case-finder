/**
 * Admin serverless function — PDF analysis + save to GitHub
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { handle } from 'hono/vercel';
import { OBJECTIONS } from '../src/data';
import { detectObjectionsFromText } from '../src/storage';
import type { Objection } from '../src/data';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const app = new Hono().basePath('/api/admin');
app.use('*', cors());

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'wpseoai2026';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = 'martijndereeper-a11y/use-case-finder';

// ─── Auth ────────────────────────────────────────────────────────────────────

app.post('/login', async (c) => {
  const { password } = await c.req.json() as { password: string };
  if (password === ADMIN_PASSWORD) return c.json({ ok: true, token: ADMIN_PASSWORD });
  return c.json({ error: 'Wrong password' }, 401);
});

// Auth middleware for all other routes
app.use('/*', async (c, next) => {
  if (c.req.method === 'OPTIONS') return next();
  const path = new URL(c.req.url).pathname;
  if (path.endsWith('/login')) return next();
  const auth = c.req.header('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  if (token !== ADMIN_PASSWORD) return c.json({ error: 'Unauthorized' }, 401);
  await next();
});

// ─── PDF Analysis ────────────────────────────────────────────────────────────

app.post('/analyze-pdf', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('pdf') as File | null;
    if (!file) return c.json({ error: 'No PDF file provided' }, 400);

    const buffer = Buffer.from(await file.arrayBuffer());

    const { PDFParse } = await import('pdf-parse');
    const parser = new (PDFParse as any)(new Uint8Array(buffer));
    await parser.load();
    const textResult = await parser.getText();
    const text = (textResult.pages || []).map((p: any) => p.text).join('\n').slice(0, 6000);

    const suggestedObjections = detectObjectionsFromText(text);

    // Claude extraction
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
  "trustSensitive": true or false,
  "countries": ["country name(s)"],
  "keywords": ["5-8 lowercase search keywords"],
  "painPattern": "best matching: No time / capacity for SEO, Underperforming agency / high SEO cost, AI / LLM search opportunity, Relied on single channel, Lack of control / visibility, Going international / scaling, Efficiency gap, Limited marketing capacity, Other"
}`,
        }],
      });
      const responseText = msg.content[0].type === 'text' ? msg.content[0].text : '';
      extracted = JSON.parse(responseText);
    } catch (aiErr: any) {
      extracted = { _error: aiErr.message };
    }

    return c.json({ suggestedObjections, extracted, preview: text.slice(0, 500).trim() });
  } catch (err: any) {
    return c.json({ error: 'Failed to parse PDF: ' + err.message }, 500);
  }
});

// ─── Save Case (commit to GitHub) ────────────────────────────────────────────

async function githubApi(path: string, method: string, body?: any) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

async function getFileSha(path: string): Promise<string | null> {
  const { status, data } = await githubApi(`contents/${path}`, 'GET');
  return status === 200 ? data.sha : null;
}

app.post('/cases', async (c) => {
  if (!GITHUB_TOKEN) return c.json({ error: 'GITHUB_TOKEN not configured' }, 500);

  try {
    const formData = await c.req.formData();
    const company = (formData.get('company') as string || '').trim();
    if (!company) return c.json({ error: 'Company name is required' }, 400);

    const pdf = formData.get('pdf') as File | null;
    if (!pdf) return c.json({ error: 'PDF file is required' }, 400);

    const pdfFileName = pdf.name;
    const pdfBuffer = Buffer.from(await pdf.arrayBuffer());
    const pdfBase64 = pdfBuffer.toString('base64');

    // Parse form fields
    const objectionsRaw = (formData.get('objections') as string || '');
    const objections = objectionsRaw ? objectionsRaw.split('|||').filter(Boolean) : [];
    const keywordsRaw = (formData.get('keywords') as string || '');
    const keywords = keywordsRaw ? keywordsRaw.split(',').map(k => k.trim().toLowerCase()).filter(Boolean) : [];
    const countriesRaw = (formData.get('countries') as string || '');
    const countries = countriesRaw ? countriesRaw.split(',').map(c => c.trim()).filter(Boolean) : [];

    const id = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

    const caseData = {
      id,
      company,
      industry: (formData.get('industry') as string || 'General').trim(),
      painPattern: (formData.get('painPattern') as string || 'Other').trim(),
      headline: (formData.get('headline') as string || '').trim(),
      outcome: (formData.get('outcome') as string || '').trim(),
      result: (formData.get('result') as string || '').trim(),
      summary: (formData.get('summary') as string || '').trim(),
      businessType: formData.get('businessType') || 'B2B',
      marketPosition: formData.get('marketPosition') || 'Mainstream',
      trustSensitive: formData.get('trustSensitive') === 'true',
      objections,
      countries,
      keywords,
      pdfFile: pdfFileName,
    };

    // 1. Upload PDF to repo
    const pdfPath = `use-cases/${pdfFileName}`;
    const pdfSha = await getFileSha(pdfPath);
    const pdfResult = await githubApi(`contents/${encodeURIComponent(pdfPath)}`, 'PUT', {
      message: `Add PDF: ${pdfFileName}`,
      content: pdfBase64,
      ...(pdfSha ? { sha: pdfSha } : {}),
    });
    if (pdfResult.status > 299) {
      return c.json({ error: 'Failed to upload PDF to GitHub', details: pdfResult.data }, 500);
    }

    // 2. Read existing added-cases.json (or start fresh)
    const casesPath = 'data/added-cases.json';
    let existingCases: any[] = [];
    const casesSha = await getFileSha(casesPath);
    if (casesSha) {
      const { data } = await githubApi(`contents/${casesPath}`, 'GET');
      existingCases = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
    }

    // Add or update case
    const idx = existingCases.findIndex((c: any) => c.id === id);
    if (idx >= 0) existingCases[idx] = caseData;
    else existingCases.push(caseData);

    // 3. Commit updated cases JSON
    const casesResult = await githubApi(`contents/${casesPath}`, 'PUT', {
      message: `Add case: ${company}`,
      content: Buffer.from(JSON.stringify(existingCases, null, 2)).toString('base64'),
      ...(casesSha ? { sha: casesSha } : {}),
    });
    if (casesResult.status > 299) {
      return c.json({ error: 'Failed to save case data to GitHub', details: casesResult.data }, 500);
    }

    return c.json({ ok: true, id, case: caseData, message: 'Saved to GitHub — Vercel will auto-redeploy.' });
  } catch (err: any) {
    return c.json({ error: 'Failed to save: ' + err.message }, 500);
  }
});

export default handle(app);
