// Search Hugging Face for African-language datasets and classify license posture.
// This is a discovery aid: it does not approve or ingest anything by itself.
//
//   node scripts/discover-hf-corpora.mjs --limit 30
//   node scripts/discover-hf-corpora.mjs --query setswana --query yoruba --json
import { writeFile } from 'node:fs/promises';

const DEFAULT_QUERIES = [
  'setswana',
  'tswana',
  'sepedi',
  'sesotho',
  'xhosa',
  'zulu',
  'tshivenda',
  'tsonga',
  'swahili',
  'yoruba',
  'hausa',
  'igbo',
  'amharic',
  'somali',
  'kinyarwanda',
  'wolof',
  'bambara',
  'luganda',
  'oromo',
  'african languages',
  'african translated',
  'african next voices',
  'masakhane',
  'afrisenti',
];

const PERMISSIVE = new Set([
  'apache-2.0',
  'mit',
  'cc0-1.0',
  'cc-by-2.0',
  'cc-by-2.5',
  'cc-by-3.0',
  'cc-by-4.0',
  'odc-by',
]);

const SHARE_ALIKE = new Set([
  'cc-by-sa-2.0',
  'cc-by-sa-3.0',
  'cc-by-sa-4.0',
]);

const RESTRICTED_FRAGMENTS = ['nc', 'noncommercial', 'nd', 'no-derivatives', 'unknown', 'other', 'noodl'];

const args = parseArgs(process.argv.slice(2));
const queryArgs = collectArgs(process.argv.slice(2), 'query');
const queries = queryArgs.length ? queryArgs : DEFAULT_QUERIES;
const limit = Number(args.limit ?? 25);
const rows = [];
const seen = new Set();

if (!Number.isInteger(limit) || limit < 1 || limit > 100) die('--limit must be an integer from 1 to 100');

for (const query of queries) {
  const url = new URL('https://huggingface.co/api/datasets');
  url.searchParams.set('search', query);
  url.searchParams.set('full', 'true');
  url.searchParams.set('limit', String(limit));

  const res = await fetch(url);
  if (!res.ok) {
    console.error(`skip query "${query}": ${res.status} ${res.statusText}`);
    continue;
  }

  const results = await res.json();
  for (const dataset of Array.isArray(results) ? results : []) {
    if (seen.has(dataset.id)) continue;
    seen.add(dataset.id);
    rows.push(summarize(dataset, query));
  }
}

rows.sort((a, b) => b.downloads - a.downloads || a.id.localeCompare(b.id));

if (args.out) {
  await writeFile(String(args.out), `${JSON.stringify({ generatedAt: new Date().toISOString(), queries, rows }, null, 2)}\n`);
}

if (args.json) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const row of rows) {
    console.log([
      row.posture.padEnd(18),
      String(row.downloads).padStart(6),
      String(row.license ?? 'unlabeled').padEnd(18),
      row.id,
      `(query: ${row.query})`,
    ].join(' '));
  }
}

function summarize(dataset, query) {
  const license = normalizeLicense(dataset.cardData?.license ?? dataset.tags?.find((tag) => tag.startsWith('license:'))?.slice(8));
  return {
    id: dataset.id,
    query,
    downloads: dataset.downloads ?? 0,
    gated: dataset.gated ?? false,
    license,
    posture: classifyLicense(license),
    tags: (dataset.tags ?? []).filter((tag) => /^(language|license|task_categories|modality):/.test(tag)).slice(0, 16),
    url: `https://huggingface.co/datasets/${dataset.id}`,
  };
}

function normalizeLicense(input) {
  const raw = Array.isArray(input) ? input[0] : input;
  return typeof raw === 'string' ? raw.toLowerCase() : null;
}

function classifyLicense(license) {
  if (!license) return 'review_required';
  if (PERMISSIVE.has(license)) return 'candidate_open';
  if (SHARE_ALIKE.has(license)) return 'share_alike_review';
  if (RESTRICTED_FRAGMENTS.some((fragment) => license.includes(fragment))) return 'restricted';
  return 'review_required';
}

function collectArgs(parts, name) {
  const values = [];
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] === `--${name}` && parts[i + 1] && !parts[i + 1].startsWith('--')) {
      values.push(parts[i + 1]);
      i += 1;
    }
  }
  return values;
}

function parseArgs(parts) {
  const out = {};
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part.startsWith('--')) continue;
    const key = part.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = parts[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function die(message) {
  console.error(message);
  process.exit(1);
}
