/**
 * One-off backfill: detect the language of every existing PDF and patch the
 * `language` field on each case in both use-cases-data.json (seed) and
 * data/added-cases.json (admin-added).
 *
 * Run with: ANTHROPIC_API_KEY=... npx tsx scripts/detect-languages.ts
 *
 * Safe to re-run — only writes a language tag when none is present, unless
 * you pass --force to overwrite. PDFs are fetched from the GitHub raw URL so
 * this works even without local PDF files.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SEED_PATH = join(ROOT, 'use-cases-data.json');
const ADDED_PATH = join(ROOT, 'data', 'added-cases.json');
const GH_RAW = 'https://raw.githubusercontent.com/martijndereeper-a11y/use-case-finder/main/use-cases';

const FORCE = process.argv.includes('--force');
const VALID = new Set(['nl', 'de', 'en']);

interface AnyCase { id: string; company: string; pdfFile: string; language?: string }

/**
 * Sample the PDF text from beginning, middle, and end so we don't get fooled
 * by a Dutch title page on an English case study (or vice versa).
 */
function sampleAcrossDocument(text: string): string {
  const t = text.trim();
  if (t.length <= 12000) return t;
  const chunk = 4000;
  const start = t.slice(0, chunk);
  const midStart = Math.floor(t.length / 2) - chunk / 2;
  const middle = t.slice(midStart, midStart + chunk);
  const end = t.slice(-chunk);
  return `${start}\n\n[...]\n\n${middle}\n\n[...]\n\n${end}`;
}

async function detectLanguageFromPdf(pdfFile: string, anthropic: Anthropic): Promise<string | null> {
  try {
    // pdf-parse v1 — import internal to skip its test file
    const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
    const url = `${GH_RAW}/${encodeURIComponent(pdfFile)}`;
    const res = await fetch(url);
    if (!res.ok) { console.warn(`  ✗ HTTP ${res.status} for ${pdfFile}`); return null; }
    const buf = Buffer.from(await res.arrayBuffer());
    const parsed = await pdfParse(buf);
    const fullText = (parsed.text || '').trim();
    if (!fullText) { console.warn(`  ✗ Empty PDF text for ${pdfFile}`); return null; }

    const sample = sampleAcrossDocument(fullText);

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 30,
      messages: [{
        role: 'user',
        content: `You are classifying the dominant language of a customer case study PDF (sampled from beginning, middle, and end).

The PDF may contain mixed languages — for example, a Dutch title slide, English body content, and a Dutch footer. Your job is to identify the language of the MAIN BODY content (paragraphs, descriptions, results, summaries) — not titles, brand names, footers, or boilerplate.

If most of the actual prose is in one language and only short fragments (titles, labels, brand names) are in another, return the language of the prose.

Return ONLY one of: nl (Dutch), de (German), en (English). No punctuation, no explanation.

PDF text sample:
${sample}`,
      }],
    });
    const txt = msg.content[0].type === 'text' ? msg.content[0].text.trim().toLowerCase() : '';
    const code = txt.slice(0, 2);
    return VALID.has(code) ? code : null;
  } catch (err: any) {
    console.warn(`  ✗ Error for ${pdfFile}: ${err.message}`);
    return null;
  }
}

async function patchFile(path: string, label: string, anthropic: Anthropic) {
  const cases: AnyCase[] = JSON.parse(readFileSync(path, 'utf-8'));
  console.log(`\n${label}: ${cases.length} cases`);
  let updated = 0;
  let skipped = 0;
  for (const c of cases) {
    if (c.language && !FORCE) { skipped++; continue; }
    process.stdout.write(`  ${c.id.padEnd(40)} `);
    const lang = await detectLanguageFromPdf(c.pdfFile, anthropic);
    if (lang) {
      c.language = lang;
      updated++;
      console.log(lang);
    } else {
      console.log('skipped');
    }
  }
  writeFileSync(path, JSON.stringify(cases, null, 2), 'utf-8');
  console.log(`${label}: ${updated} updated, ${skipped} already-tagged`);
}

(async () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is required.');
    process.exit(1);
  }
  const anthropic = new Anthropic();
  await patchFile(SEED_PATH, 'Seed (use-cases-data.json)', anthropic);
  await patchFile(ADDED_PATH, 'Added (data/added-cases.json)', anthropic);
  console.log('\nDone. Commit + push these two files, then redeploy.');
})();
