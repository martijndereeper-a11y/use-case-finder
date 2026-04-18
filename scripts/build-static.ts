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

// Multilingual search terms (NL + DE) per case, plus global synonym map
const nlDeKeywords: Record<string, string[]> = {};
allCases.forEach(c => {
  const extra: string[] = [];
  // Dutch industry terms
  if (c.industry.match(/ICT|IT/i)) extra.push('ict', 'technologie', 'informatietechnologie', 'Technologie', 'Informationstechnologie');
  if (c.industry.match(/Recruit|Staff|HR/i)) extra.push('werving', 'selectie', 'uitzendbureau', 'personeel', 'Rekrutierung', 'Personal', 'Personalvermittlung');
  if (c.industry.match(/Fitness|Sports|Health/i)) extra.push('sport', 'fitness', 'gezondheid', 'beweging', 'Gesundheit', 'Bewegung', 'Fitness');
  if (c.industry.match(/Restaurant|F&B|Dining/i)) extra.push('restaurant', 'horeca', 'eten', 'Restaurant', 'Gastronomie');
  if (c.industry.match(/Fashion|Retail/i)) extra.push('mode', 'kleding', 'winkel', 'Mode', 'Kleidung', 'Einzelhandel');
  if (c.industry.match(/Energy|Installation/i)) extra.push('energie', 'installatie', 'zonnepanelen', 'warmtepomp', 'Energie', 'Installation', 'Solaranlage');
  if (c.industry.match(/Construction|Carpentry/i)) extra.push('bouw', 'timmerman', 'aannemer', 'Bau', 'Zimmerei', 'Handwerk');
  if (c.industry.match(/Automotive/i)) extra.push('auto', 'garage', 'dealer', 'autobedrijf', 'Autohaus', 'Werkstatt');
  if (c.industry.match(/Art|Gallery/i)) extra.push('kunst', 'galerie', 'Kunst', 'Galerie');
  if (c.industry.match(/Real Estate|Office|Flex/i)) extra.push('kantoor', 'vastgoed', 'werkplek', 'Büro', 'Immobilien', 'Arbeitsplatz');
  if (c.industry.match(/Financial|Pension|Accounting/i)) extra.push('financieel', 'pensioen', 'boekhouding', 'administratie', 'Finanzen', 'Buchhaltung', 'Rente');
  if (c.industry.match(/Events|Hospitality/i)) extra.push('evenementen', 'teambuilding', 'bedrijfsuitje', 'Veranstaltungen', 'Teambuilding');
  if (c.industry.match(/SaaS|Software/i)) extra.push('software', 'platform', 'app', 'Software', 'Plattform');
  if (c.industry.match(/Pest/i)) extra.push('ongedierte', 'plaagdier', 'Schädlingsbekämpfung');
  if (c.industry.match(/Beauty|Salon|Hair/i)) extra.push('kapper', 'salon', 'schoonheid', 'Friseur', 'Schönheit');
  if (c.industry.match(/Parking|Mobility/i)) extra.push('parkeren', 'mobiliteit', 'Parken', 'Mobilität');
  if (c.industry.match(/Nursery|Agriculture|Horticulture/i)) extra.push('kwekerij', 'landbouw', 'tuinbouw', 'planten', 'Gärtnerei', 'Landwirtschaft', 'Pflanzen');
  if (c.industry.match(/Beer|Craft/i)) extra.push('bier', 'speciaal bier', 'Bier', 'Craft');
  if (c.industry.match(/Media|E-commerce/i)) extra.push('media', 'webshop', 'online winkel', 'Medien', 'Onlineshop');
  if (c.industry.match(/Public Sector|Research|Consulting/i)) extra.push('overheid', 'gemeente', 'onderzoek', 'Regierung', 'Gemeinde', 'Forschung');
  if (c.industry.match(/Social|Disability/i)) extra.push('sociaal', 'autisme', 'beperking', 'inclusie', 'Sozial', 'Autismus', 'Inklusion');
  if (c.industry.match(/Medical|Healthcare|Physio/i)) extra.push('medisch', 'gezondheid', 'fysiotherapie', 'zorg', 'Medizin', 'Gesundheit', 'Physiotherapie');
  if (c.industry.match(/Industrial|Equipment|Cleaning/i)) extra.push('industrieel', 'apparatuur', 'reiniging', 'Industrie', 'Ausrüstung', 'Reinigung');
  // Dutch/German country names
  if ((c.countries||[]).includes('Netherlands')) extra.push('nederland', 'nederlanden', 'Niederlande', 'Holland');
  if ((c.countries||[]).includes('Germany')) extra.push('duitsland', 'Deutschland');
  if ((c.countries||[]).includes('Finland')) extra.push('finland', 'Finnland');
  if ((c.countries||[]).includes('Sweden')) extra.push('zweden', 'Schweden');
  if ((c.countries||[]).includes('United Kingdom')) extra.push('verenigd koninkrijk', 'Großbritannien', 'Vereinigtes Königreich');
  nlDeKeywords[c.id] = extra;
});

// Global synonym map for common search terms
const synonymMap = {
  // Dutch -> English search terms
  'geen': 'no', 'tijd': 'time', 'voor': 'for', 'bureau': 'agency', 'levert': 'delivering',
  'niet': 'not', 'werkt': 'work', 'resultaat': 'results', 'resultaten': 'results',
  'te': 'too', 'duur': 'expensive', 'klein': 'small', 'groot': 'large',
  'zoeken': 'search', 'niemand': 'nobody', 'klanten': 'customers', 'online': 'online',
  'internationaal': 'international', 'groei': 'growth', 'kosten': 'cost',
  'advertenties': 'ads', 'verkeer': 'traffic', 'leads': 'leads',
  'website': 'website', 'inhoud': 'content', 'capaciteit': 'capacity',
  'efficiëntie': 'efficiency', 'efficientie': 'efficiency',
  'mond-tot-mond': 'word of mouth', 'mond': 'mouth', 'mondtotmond': 'word of mouth',
  'vertrouwen': 'trust', 'gevoelig': 'sensitive',
  'niche': 'niche', 'markt': 'market', 'sector': 'sector',
  'technisch': 'technical', 'complex': 'complex',
  'geprobeerd': 'tried', 'eerder': 'before', 'lang': 'long',
  // German -> English search terms
  'keine': 'no', 'zeit': 'time', 'für': 'for', 'agentur': 'agency',
  'ergebnisse': 'results', 'ergebnis': 'result', 'teuer': 'expensive',
  'zu': 'too', 'suchen': 'search', 'kunden': 'customers',
  'wachstum': 'growth', 'kosten': 'cost', 'anzeigen': 'ads',
  'mundpropaganda': 'word of mouth', 'empfehlung': 'referral',
  'vertrauen': 'trust', 'branche': 'sector', 'technisch': 'technical',
  'komplex': 'complex', 'versucht': 'tried', 'vorher': 'before',
  'dauert': 'takes', 'ergebnissen': 'results',
  'inhalt': 'content', 'kapazität': 'capacity', 'effizienz': 'efficiency',
  'international': 'international',
};

const data = { cases: allCases, painPatterns, industries, objections: OBJECTIONS, objectionCounts, nlDeKeywords, synonymMap };

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
  var synMap = window.__DATA__.synonymMap || {};
  var nlDe = window.__DATA__.nlDeKeywords || {};
  // Translate query terms using synonym map
  var rawTerms = query.toLowerCase().split(/\\s+/);
  var terms = [];
  rawTerms.forEach(function(t) { terms.push(t); if (synMap[t]) terms.push(synMap[t]); });
  var scored = allCases.map(function(uc) {
    var extra = (nlDe[uc.id] || []).join(' ').toLowerCase();
    var s = [uc.company,uc.industry,uc.painPattern,uc.headline,uc.outcome,uc.result,uc.summary,uc.businessType,uc.marketPosition,...uc.keywords,...uc.objections,...(uc.countries||[]),extra].join(' ').toLowerCase();
    var score = 0;
    for (var i=0;i<terms.length;i++) { var t=terms[i]; if (s.includes(t)) score++; if (uc.keywords.some(function(k){return k.includes(t)})) score++; if (uc.company.toLowerCase().includes(t)) score+=2; if (uc.industry.toLowerCase().includes(t)) score+=2; }
    return Object.assign({}, uc, {score:score});
  });
  renderResults(scored.filter(function(r){return r.score>0}).sort(function(a,b){return b.score-a.score}));
}`
);

// 4. Clean up apiUrl (not needed for static, chat uses absolute /api/chat)
html = html.replace(`function apiUrl(path) { return path; }\n`, '');

writeFileSync(join(OUT, 'index.html'), html);

// Copy admin page as-is (it talks to the serverless function)
const adminHtml = readFileSync(join(ROOT, 'src', 'dashboard', 'admin.html'), 'utf-8');
writeFileSync(join(OUT, 'admin.html'), adminHtml);

// Copy industries page as-is (it talks to the serverless function)
const industriesHtml = readFileSync(join(ROOT, 'src', 'dashboard', 'industries.html'), 'utf-8');
writeFileSync(join(OUT, 'industries.html'), industriesHtml);

console.log(`Built public/index.html (${(html.length/1024).toFixed(0)} KB, ${data.cases.length} cases embedded)`);
console.log(`Built public/admin.html`);
console.log(`Built public/industries.html`);
