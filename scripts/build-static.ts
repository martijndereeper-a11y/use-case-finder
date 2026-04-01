import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useCases as seedCases, OBJECTIONS, type UseCase } from '../src/data.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'public');
const PDF_BASE = 'https://raw.githubusercontent.com/martijndereeper-a11y/use-case-finder/main/use-cases';

mkdirSync(OUT, { recursive: true });

// Merge seed cases + admin-added cases
let addedCases: UseCase[] = [];
const addedPath = join(ROOT, 'data', 'added-cases.json');
try {
  if (existsSync(addedPath)) {
    addedCases = JSON.parse(readFileSync(addedPath, 'utf-8'));
    console.log(`Loaded ${addedCases.length} admin-added cases`);
  }
} catch {}

const addedIds = new Set(addedCases.map(c => c.id));
const allCases = [...seedCases.filter(c => !addedIds.has(c.id)), ...addedCases];

const painPatterns = [...new Set(allCases.map(c => c.painPattern))];
const industries = [...new Set(allCases.map(c => c.industry))];
const objectionCounts = OBJECTIONS.map(obj => ({
  objection: obj,
  count: allCases.filter(c => c.objections.includes(obj)).length,
}));

const data = { cases: allCases, painPatterns, industries, objections: OBJECTIONS, objectionCounts };

let html = readFileSync(join(ROOT, 'src', 'dashboard', 'index.html'), 'utf-8');

// 1. Inject data before </head>
html = html.replace('</head>', `<script>window.__DATA__=${JSON.stringify(data)};</script>\n</head>`);

// 2. Replace init() to use embedded data instead of fetch
html = html.replace(
  /async function init\(\) \{[\s\S]*?const data = await res\.json\(\);/,
  `async function init() {\n  const data = window.__DATA__;`
);

// 3. Replace doSearch to be client-side
html = html.replace(
  /async function doSearch[\s\S]*?renderResults\(data\.results\);\s*\}/,
  `function doSearch(query) {
  if (!query) { renderResults(allCases); document.getElementById('quickMatch').style.display = ''; return; }
  document.getElementById('quickMatch').style.display = 'none';
  const terms = query.toLowerCase().split(/\\s+/);
  const scored = allCases.map(uc => {
    const s = [uc.company,uc.industry,uc.painPattern,uc.headline,uc.outcome,uc.result,uc.summary,uc.businessType,uc.marketPosition,...uc.keywords,...uc.objections,...(uc.countries||[])].join(' ').toLowerCase();
    let score = 0;
    for (const t of terms) { if (s.includes(t)) score++; if (uc.keywords.some(k=>k.includes(t))) score++; if (uc.company.toLowerCase().includes(t)) score+=2; if (uc.industry.toLowerCase().includes(t)) score+=2; }
    return { ...uc, score };
  });
  renderResults(scored.filter(r => r.score > 0).sort((a, b) => b.score - a.score));
}`
);

// 4. Rewrite PDF URLs to GitHub raw
html = html.replaceAll(
  "${apiUrl('/use-cases/pdf/')}${encodeURIComponent(c.pdfFile)}",
  `${PDF_BASE}/\${encodeURIComponent(c.pdfFile)}`
);

// 5. Clean up apiUrl (not needed for static, chat uses absolute /api/chat)
html = html.replace(`function apiUrl(path) { return path; }\n`, '');

writeFileSync(join(OUT, 'index.html'), html);

// Copy admin page as-is (it talks to the serverless function)
const adminHtml = readFileSync(join(ROOT, 'src', 'dashboard', 'admin.html'), 'utf-8');
writeFileSync(join(OUT, 'admin.html'), adminHtml);

console.log(`Built public/index.html (${(html.length/1024).toFixed(0)} KB, ${data.cases.length} cases embedded)`);
console.log(`Built public/admin.html`);
