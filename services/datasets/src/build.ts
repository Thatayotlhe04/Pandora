import { parseArgs } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { getSupabase, putObject, logger } from '@pandora/core';

/**
 * Build a versioned, provenance-stamped training dataset from the lake.
 *
 *   tsx src/build.ts --name nubia-tutoring-v1 \
 *     --scope model_training --source nubia --type ai.queried,ai.responded,ai.feedback \
 *     --group session --from 2025-01-01 --to 2026-01-01
 *
 * Output: JSONL in R2 under datasets/<id>/data.jsonl + manifest.json, and a row
 * in the `datasets` table. Atomic mode = one event per line; grouped mode = one
 * coherent sequence per line (long-context training examples).
 *
 * Integrity: model_training is distributable unless a user opted out.
 * product_improvement is metadata-only and never distributable; it requires
 * --internal and is stamped accordingly. (Ingest already rejects content from
 * that scope.)
 */

interface Row {
  event_id: string;
  source: string;
  scope: string;
  type: string;
  user_id: string;
  session_id: string | null;
  ts: string;
  schema_version: number;
  data: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
}

const PAGE = 1000;

function parse() {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      scope: { type: 'string', default: 'model_training' },
      source: { type: 'string' },
      type: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      group: { type: 'string', default: 'none' }, // none | session | user
      internal: { type: 'boolean', default: false },
    },
  });

  if (!values.name) throw new Error('--name is required');
  const scope = values.scope as string;
  if (scope !== 'model_training' && scope !== 'product_improvement') {
    throw new Error(`--scope must be model_training or product_improvement`);
  }
  if (scope === 'product_improvement' && !values.internal) {
    throw new Error(
      'product_improvement data is internal-only and not distributable. Pass --internal to build an internal analytics cut.'
    );
  }
  const group = values.group as string;
  if (!['none', 'session', 'user'].includes(group)) {
    throw new Error('--group must be none, session, or user');
  }

  return {
    name: values.name as string,
    scope,
    sources: splitCsv(values.source),
    types: splitCsv(values.type),
    from: values.from as string | undefined,
    to: values.to as string | undefined,
    group: group as 'none' | 'session' | 'user',
    distributable: scope === 'model_training',
  };
}

function splitCsv(v: string | undefined): string[] {
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

function baseQuery(opts: ReturnType<typeof parse>) {
  let q = getSupabase()
    .from('events')
    .select('event_id,source,scope,type,user_id,session_id,ts,schema_version,data,context')
    .eq('scope', opts.scope);
  if (opts.sources.length) q = q.in('source', opts.sources);
  if (opts.types.length) q = q.in('type', opts.types);
  if (opts.from) q = q.gte('ts', opts.from);
  if (opts.to) q = q.lte('ts', opts.to);
  return q;
}

async function* pages(opts: ReturnType<typeof parse>): AsyncGenerator<Row[]> {
  const orderCol = opts.group === 'user' ? 'user_id' : opts.group === 'session' ? 'session_id' : 'ts';
  for (let offset = 0; ; offset += PAGE) {
    let q = baseQuery(opts).order(orderCol, { ascending: true });
    if (opts.group !== 'none') q = q.order('ts', { ascending: true });
    const { data, error } = await q.range(offset, offset + PAGE - 1);
    if (error) throw new Error(`query failed: ${error.message}`);
    const rows = (data ?? []) as Row[];
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < PAGE) return;
  }
}

function eventOut(r: Row) {
  return {
    eventId: r.event_id,
    source: r.source,
    type: r.type,
    userId: r.user_id,
    sessionId: r.session_id,
    ts: r.ts,
    data: r.data ?? {},
  };
}

async function main(): Promise<void> {
  const opts = parse();
  const datasetId = randomUUID();
  const tmp = join(tmpdir(), `ds-${datasetId}.jsonl`);
  const out = createWriteStream(tmp);
  const hash = createHash('sha256');

  const write = (obj: unknown): void => {
    const line = JSON.stringify(obj) + '\n';
    hash.update(line);
    out.write(line);
  };

  const sourcesSeen = new Set<string>();
  const typesSeen = new Set<string>();
  const schemaVersions = new Set<number>();
  let eventCount = 0;
  let lineCount = 0;

  let curKey: string | null = null;
  let curEvents: Row[] = [];
  const groupKey = (r: Row): string => (opts.group === 'user' ? r.user_id : r.session_id ?? '∅');
  const flushGroup = (): void => {
    if (curEvents.length === 0) return;
    const first = curEvents[0]!;
    write({
      groupKey: curKey,
      groupBy: opts.group,
      source: first.source,
      userId: first.user_id,
      sessionId: first.session_id,
      events: curEvents.map(eventOut),
    });
    lineCount++;
    curEvents = [];
  };

  for await (const batch of pages(opts)) {
    for (const r of batch) {
      sourcesSeen.add(r.source);
      typesSeen.add(r.type);
      schemaVersions.add(r.schema_version);
      eventCount++;

      if (opts.group === 'none') {
        write(eventOut(r));
        lineCount++;
      } else {
        const k = groupKey(r);
        if (curKey !== null && k !== curKey) flushGroup();
        curKey = k;
        curEvents.push(r);
      }
    }
  }
  if (opts.group !== 'none') flushGroup();

  await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));

  if (eventCount === 0) {
    await unlink(tmp).catch(() => undefined);
    logger.warn('no events matched; nothing built');
    console.log(JSON.stringify({ ok: false, reason: 'no matching events' }, null, 2));
    return;
  }

  const buf = await readFile(tmp);
  const contentSha256 = hash.digest('hex');
  const objectKey = `datasets/${datasetId}/data.jsonl`;

  const manifest = {
    datasetId,
    name: opts.name,
    producedBy: 'pandora',
    createdAt: new Date().toISOString(),
    scope: opts.scope,
    consentBasis: opts.scope === 'model_training' ? 'opt-out:model_training' : 'internal:product_improvement',
    distributable: opts.distributable,
    sources: [...sourcesSeen].sort(),
    eventTypes: [...typesSeen].sort(),
    schemaVersions: [...schemaVersions].sort((a, b) => a - b),
    groupBy: opts.group,
    fromTs: opts.from ?? null,
    toTs: opts.to ?? null,
    eventCount,
    lineCount,
    format: 'jsonl',
    objectKey,
    bytes: buf.length,
    contentSha256,
  };

  await putObject(objectKey, buf, 'application/x-ndjson');
  await putObject(`datasets/${datasetId}/manifest.json`, JSON.stringify(manifest, null, 2), 'application/json');

  const { error } = await getSupabase().from('datasets').insert({
    dataset_id: datasetId,
    name: opts.name,
    scope: opts.scope,
    sources: manifest.sources,
    event_types: manifest.eventTypes,
    from_ts: opts.from ?? null,
    to_ts: opts.to ?? null,
    row_count: lineCount,
    schema_versions: manifest.schemaVersions,
    format: 'jsonl',
    object_key: objectKey,
    manifest,
    content_sha256: contentSha256,
    distributable: opts.distributable,
  });
  if (error) throw new Error(`datasets insert failed: ${error.message}`);

  await unlink(tmp).catch(() => undefined);
  logger.info({ datasetId, eventCount, lineCount, bytes: buf.length }, 'dataset built');
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((err) => {
  logger.error({ err: String(err) }, 'dataset build failed');
  console.error(String(err));
  process.exit(1);
});
