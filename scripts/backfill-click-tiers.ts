/**
 * One-off backfill: repair the clickTier on admin-added cases.
 *
 * Why this exists: until the fix in api/index.ts, POST /api/admin/cases hardcoded
 * clickTier: 'Starting near zero (0-100)' on every uploaded case, so 26 of the 27 cases
 * in data/added-cases.json carried a tier nobody ever measured. The corrections live in
 * data/click-tier-backfill.json, each with the quote from the case PDF it came from.
 *
 * Reads and writes data/added-cases.json on GitHub directly — the same file the live API
 * reads — so it does not care whether your local clone is up to date.
 *
 * Usage:
 *   GITHUB_TOKEN=… npx tsx scripts/backfill-click-tiers.ts            # dry run, prints the diff
 *   GITHUB_TOKEN=… npx tsx scripts/backfill-click-tiers.ts --write    # commits to the repo
 *
 * No Node on this machine? scripts/backfill-click-tiers.py does the same with stock python3.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GH_REPO = 'martijndereeper-a11y/use-case-finder';
const GH_PATH = 'data/added-cases.json';
const API = `https://api.github.com/repos/${GH_REPO}/contents/${GH_PATH}`;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const WRITE = process.argv.includes('--write');

if (!GH_TOKEN) {
  console.error('GITHUB_TOKEN is not set. Export the deploy token first.');
  process.exit(1);
}

interface Backfill { id: string; company: string; clickTier: string; confidence: string; evidence: string }
const backfill: Backfill[] = JSON.parse(
  readFileSync(join(ROOT, 'data', 'click-tier-backfill.json'), 'utf-8'),
).cases;

const headers = { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json' };

const res = await fetch(API, { headers });
if (!res.ok) {
  const detail = (await res.text()).slice(0, 300);
  console.error(res.status === 401
    ? `GitHub rejected the token (401). It has expired or been revoked.\n${detail}`
    : `Could not read ${GH_PATH}: GitHub ${res.status}\n${detail}`);
  process.exit(1);
}
const meta = await res.json() as { content: string; sha: string };
const cases = JSON.parse(Buffer.from(meta.content, 'base64').toString('utf-8')) as Array<Record<string, unknown>>;
console.log(`Read ${cases.length} admin-added cases from GitHub.\n`);

let changed = 0, already = 0;
const missing: string[] = [];
for (const row of backfill) {
  const target = cases.find(c => c.id === row.id);
  if (!target) { missing.push(row.id); continue; }
  if (target.clickTier === row.clickTier) { already++; continue; }
  const flag = row.confidence === 'stated' ? '' : '   (inferred — confirm)';
  console.log(`  ${row.company.slice(0, 34).padEnd(36)} ${String(target.clickTier).padEnd(27)} -> ${row.clickTier}${flag}`);
  target.clickTier = row.clickTier;
  changed++;
}

if (missing.length) console.warn(`\nNot found in ${GH_PATH}, check by hand: ${missing.join(', ')}`);
console.log(`\n${changed} to change, ${already} already correct.`);

if (!WRITE) { console.log('Dry run — re-run with --write to commit.'); process.exit(0); }
if (!changed) process.exit(0);

const put = await fetch(API, {
  method: 'PUT',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: 'Backfill clickTier on admin-added cases from their PDFs',
    content: Buffer.from(JSON.stringify(cases, null, 2)).toString('base64'),
    sha: meta.sha,
  }),
});
if (!put.ok) {
  console.error(`Write failed: GitHub ${put.status} ${(await put.text()).slice(0, 300)}`);
  process.exit(1);
}
console.log(`Wrote ${changed} correction(s) to ${GH_PATH}.`);
console.log('The live site picks these up on its next /api/use-cases call — no redeploy needed.');
