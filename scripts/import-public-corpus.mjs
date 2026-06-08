// Import public language corpora into Pandora through the signed ingest API.
//
// Dry run first:
//   node scripts/import-public-corpus.mjs --limit 5
//
// Live ingest:
//   node scripts/import-public-corpus.mjs --live \
//     --endpoint https://pandora.example \
//     --key pk_nubia_xxx \
//     --secret "$PANDORA_SECRET" \
//     --source nubia \
//     --limit 1000
import { createHmac, randomUUID } from 'node:crypto';

const MT560 = {
  sourceId: 'hf-michsethowusu-english-setswana-mt560',
  dataset: 'michsethowusu/english-setswana_sentence-pairs_mt560',
  config: 'default',
  split: 'train',
  sourceUrl: 'https://huggingface.co/datasets/michsethowusu/english-setswana_sentence-pairs_mt560',
  license: 'CC BY 4.0',
  upstream: 'OPUS MT560',
  languages: ['en', 'tn'],
};

const args = parseArgs(process.argv.slice(2));
const limit = Number(args.limit ?? 100);
const offset = Number(args.offset ?? 0);
const batchSize = Math.min(Number(args.batchSize ?? 100), 100);
const live = Boolean(args.live);
const source = String(args.source ?? 'nubia');

if (!Number.isInteger(limit) || limit < 1) die('--limit must be a positive integer');
if (!Number.isInteger(offset) || offset < 0) die('--offset must be a non-negative integer');
if (!Number.isInteger(batchSize) || batchSize < 1) die('--batch-size must be a positive integer');

if (live) {
  for (const key of ['endpoint', 'key', 'secret']) {
    if (!args[key]) die(`--${key} is required when --live is set`);
  }
}

let sent = 0;
let previewed = 0;
for await (const rows of fetchRows({ offset, limit, batchSize })) {
  const events = rows.map(({ row_idx, row }) => toEvent({ rowIndex: row_idx, row, source }));
  if (!live) {
    for (const event of events.slice(0, Math.max(0, 5 - previewed))) {
      console.log(JSON.stringify(event, null, 2));
      previewed += 1;
    }
  } else {
    await sendBatch(events);
  }
  sent += events.length;
  console.error(`${live ? 'ingested' : 'prepared'} ${sent}/${limit}`);
}

console.error(live
  ? `done: ingested ${sent} public-corpus events`
  : `dry run: prepared ${sent} events; rerun with --live to ingest`);

async function* fetchRows({ offset: start, limit: total, batchSize: size }) {
  let cursor = start;
  let remaining = total;
  while (remaining > 0) {
    const length = Math.min(size, remaining);
    const url = new URL('https://datasets-server.huggingface.co/rows');
    url.searchParams.set('dataset', MT560.dataset);
    url.searchParams.set('config', MT560.config);
    url.searchParams.set('split', MT560.split);
    url.searchParams.set('offset', String(cursor));
    url.searchParams.set('length', String(length));

    const res = await fetch(url);
    if (!res.ok) die(`Hugging Face rows request failed: ${res.status} ${await res.text()}`);
    const payload = await res.json();
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    if (rows.length === 0) return;
    yield rows;
    cursor += rows.length;
    remaining -= rows.length;
  }
}

function toEvent({ rowIndex, row, source }) {
  return {
    eventId: randomUUID(),
    source,
    scope: 'model_training',
    type: 'public_corpus.sentence_pair',
    userId: `public:${MT560.sourceId}`,
    ts: new Date().toISOString(),
    schemaVersion: 1,
    data: {
      sourceId: MT560.sourceId,
      sourceUrl: MT560.sourceUrl,
      license: MT560.license,
      upstream: MT560.upstream,
      rowIndex,
      languagePair: MT560.languages,
      en: String(row.eng ?? ''),
      tn: String(row.tsn ?? ''),
    },
    context: {
      lib: 'pandora/public-corpus-importer',
      sdkVersion: 'public-corpus-importer-1',
    },
  };
}

async function sendBatch(events) {
  const endpoint = String(args.endpoint).replace(/\/$/, '');
  const body = JSON.stringify({ events });
  const ts = Math.floor(Date.now() / 1000).toString();
  const signature = `sha256=${createHmac('sha256', String(args.secret)).update(`${ts}.${body}`).digest('hex')}`;

  const res = await fetch(`${endpoint}/ingest/batch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-pandora-key': String(args.key),
      'x-pandora-source': source,
      'x-pandora-timestamp': ts,
      'x-pandora-signature': signature,
    },
    body,
  });
  if (!res.ok) die(`Pandora ingest failed: ${res.status} ${await res.text()}`);
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
