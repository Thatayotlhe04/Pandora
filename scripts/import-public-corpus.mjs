// Import approved public African-language corpora into Pandora through the
// signed ingest API. The registry keeps restricted/evaluation-only sources in
// view, but this script only imports sources explicitly approved for
// model_training distribution.
//
// List importable sources:
//   node scripts/import-public-corpus.mjs --list
//
// Dry run a controlled slice:
//   node scripts/import-public-corpus.mjs --all --limit-per-source 2
//
// Live ingest:
//   node scripts/import-public-corpus.mjs --all --live \
//     --endpoint https://pandora.example \
//     --key pk_nubia_xxx \
//     --secret "$PANDORA_SECRET" \
//     --source nubia \
//     --limit-per-source 1000
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_REGISTRY = 'datasets/sources/african-open-corpora.json';
const IMPORTABLE_STATUS = new Set(['approved']);

const args = parseArgs(process.argv.slice(2));
const registryPath = resolve(String(args.registry ?? DEFAULT_REGISTRY));
const registry = JSON.parse(await readFile(registryPath, 'utf8'));
const source = String(args.source ?? 'nubia');
const live = Boolean(args.live);
const batchSize = Math.min(Number(args.batchSize ?? 100), 100);
const offset = Number(args.offset ?? 0);
const defaultLimit = Number(args.limit ?? 100);
const limitPerSource = Number(args.limitPerSource ?? defaultLimit);
const previewLimit = Number(args.previewLimit ?? 5);
const requestTimeoutMs = Number(args.requestTimeoutMs ?? 15000);
const continueOnError = Boolean(args.continueOnError);

if (!Number.isInteger(batchSize) || batchSize < 1) die('--batch-size must be a positive integer');
if (!Number.isInteger(offset) || offset < 0) die('--offset must be a non-negative integer');
if (!Number.isInteger(defaultLimit) || defaultLimit < 1) die('--limit must be a positive integer');
if (!Number.isInteger(limitPerSource) || limitPerSource < 1) die('--limit-per-source must be a positive integer');
if (!Number.isInteger(previewLimit) || previewLimit < 0) die('--preview-limit must be a non-negative integer');
if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000) die('--request-timeout-ms must be at least 1000');

if (live) {
  for (const key of ['endpoint', 'key', 'secret']) {
    if (!args[key]) die(`--${key} is required when --live is set`);
  }
}

const allSources = Array.isArray(registry.sources) ? registry.sources : [];
const selected = selectSources(allSources);

if (args.list) {
  for (const item of allSources) {
    const marker = isImportable(item) ? 'importable' : item.status;
    console.log(`${item.id}\t${marker}\t${item.license}\t${item.name}`);
  }
  process.exit(0);
}

if (selected.length === 0) die('no matching importable sources found');

let totalPrepared = 0;
let totalPreviewed = 0;

for (const item of selected) {
  if (item.adapter !== 'hf_rows') {
    console.error(`skip ${item.id}: adapter '${item.adapter}' is not supported by this importer`);
    continue;
  }

  console.error(`source ${item.id}: ${item.dataset}/${item.config}/${item.split}`);
  let sourcePrepared = 0;

  try {
    for await (const rows of fetchHfRows({
      dataset: item.dataset,
      config: item.config,
      split: item.split,
      offset,
      limit: limitPerSource,
      batchSize,
    })) {
      const events = rows.map(({ row_idx, row }) => toEvent({ item, rowIndex: row_idx, row, source }));

      if (!live) {
        for (const event of events.slice(0, Math.max(0, previewLimit - totalPreviewed))) {
          console.log(stringifyPreview(event));
          totalPreviewed += 1;
        }
      } else {
        await sendBatch(events);
      }

      sourcePrepared += events.length;
      totalPrepared += events.length;
      console.error(`${live ? 'ingested' : 'prepared'} ${sourcePrepared}/${limitPerSource} from ${item.id}`);
    }
  } catch (error) {
    if (!continueOnError) throw error;
    console.error(`skip ${item.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.error(live
  ? `done: ingested ${totalPrepared} public-corpus events from ${selected.length} source(s)`
  : `dry run: prepared ${totalPrepared} events from ${selected.length} source(s); rerun with --live to ingest`);

function selectSources(sources) {
  if (args.sourceId) {
    const wanted = new Set(String(args.sourceId).split(',').map((part) => part.trim()).filter(Boolean));
    return sources.filter((item) => wanted.has(item.id) && isImportable(item));
  }

  if (args.all) return sources.filter(isImportable);

  const legacy = sources.find((item) => item.id === 'hf-michsethowusu-english-setswana-mt560');
  return legacy && isImportable(legacy) ? [legacy] : sources.filter(isImportable).slice(0, 1);
}

function isImportable(item) {
  return item
    && IMPORTABLE_STATUS.has(item.status)
    && item.approvedForModelTraining === true
    && item.adapter === 'hf_rows';
}

async function* fetchHfRows({ dataset, config, split, offset: start, limit: total, batchSize: size }) {
  let cursor = start;
  let remaining = total;

  while (remaining > 0) {
    const length = Math.min(size, remaining);
    const url = new URL('https://datasets-server.huggingface.co/rows');
    url.searchParams.set('dataset', dataset);
    url.searchParams.set('config', config);
    url.searchParams.set('split', split);
    url.searchParams.set('offset', String(cursor));
    url.searchParams.set('length', String(length));

    const res = await fetchWithRetry(url);
    if (!res.ok) die(`Hugging Face rows request failed for ${dataset}: ${res.status} ${await res.text()}`);
    const payload = await res.json();
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    if (rows.length === 0) return;

    yield rows;
    cursor += rows.length;
    remaining -= rows.length;
  }
}

async function fetchWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      return res;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt === 1) {
        console.error(`retry Hugging Face request after ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  throw lastError;
}

function toEvent({ item, rowIndex, row, source: eventSource }) {
  return {
    eventId: randomUUID(),
    source: eventSource,
    scope: 'model_training',
    type: 'public_corpus.record',
    userId: `public:${item.id}`,
    ts: new Date().toISOString(),
    schemaVersion: 1,
    data: {
      sourceId: item.id,
      sourceName: item.name,
      sourceUrl: item.sourceUrl,
      license: item.license,
      licenseUrl: item.licenseUrl,
      licenseStatus: item.allowedDistribution,
      rowIndex,
      languageTags: item.languages,
      modalities: item.modalities,
      task: item.task,
      split: item.split,
      config: item.config,
      attribution: item.attribution,
      payload: selectPayload(row, item.fields),
    },
    context: {
      lib: 'pandora/public-corpus-importer',
      sdkVersion: 'public-corpus-importer-2',
    },
  };
}

function selectPayload(row, fields = {}) {
  const include = Array.isArray(fields.include) ? fields.include : null;
  const omit = new Set(Array.isArray(fields.omit) ? fields.omit : []);
  const out = {};

  for (const [key, value] of Object.entries(row ?? {})) {
    if (include && !include.includes(key)) continue;
    if (omit.has(key)) continue;
    out[key] = stripEphemeralAssetUrls(value);
  }

  return out;
}

function stripEphemeralAssetUrls(value) {
  if (Array.isArray(value)) return value.map(stripEphemeralAssetUrls);
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'src' && typeof child === 'string' && child.includes('datasets-server.huggingface.co/cached-assets')) {
      out.src = '[omitted: ephemeral Hugging Face cached asset URL]';
      continue;
    }
    out[key] = stripEphemeralAssetUrls(child);
  }
  return out;
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

function stringifyPreview(event) {
  return JSON.stringify(truncateForPreview(event), null, 2);
}

function truncateForPreview(value) {
  if (typeof value === 'string') return value.length > 700 ? `${value.slice(0, 700)}... [preview truncated]` : value;
  if (Array.isArray(value)) return value.slice(0, 8).map(truncateForPreview);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) out[key] = truncateForPreview(child);
  return out;
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
