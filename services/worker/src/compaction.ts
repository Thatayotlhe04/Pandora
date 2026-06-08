import { getSupabase, getRedis, getEnv, logger } from '@pandora/core';
import type { EventEnvelope } from '@pandora/schema';
import { writeParquetPartition } from './sinks/r2.js';

const LOCK_KEY = 'pandora:compaction:lock';
const LOCK_TTL_SEC = 300;

interface Row {
  id: number;
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

/**
 * Cold path. Postgres is the durable source of truth; this reads rows that
 * haven't been written to R2 yet, groups them by source/scope/date, writes one
 * Parquet object per group, and stamps compacted_at. A Redis lock keeps two
 * runs from overlapping.
 */
export async function runCompaction(): Promise<void> {
  const redis = getRedis();
  const acquired = await redis.set(LOCK_KEY, '1', 'EX', LOCK_TTL_SEC, 'NX');
  if (!acquired) {
    logger.debug('compaction already running; skipping');
    return;
  }

  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('events')
      .select('id,event_id,source,scope,type,user_id,session_id,ts,schema_version,data,context')
      .is('compacted_at', null)
      .order('id', { ascending: true })
      .limit(getEnv().COMPACTION_BATCH);

    if (error) throw new Error(`compaction select failed: ${error.message}`);

    const rows = (data ?? []) as Row[];
    if (rows.length === 0) return;

    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const dt = r.ts.slice(0, 10); // YYYY-MM-DD from the timestamptz ISO string
      const key = `${r.source}|${r.scope}|${dt}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push(r);
      else groups.set(key, [r]);
    }

    const compactedIds: number[] = [];
    for (const [key, group] of groups) {
      const [source = '', scope = '', dt = ''] = key.split('|');
      const events = group.map(toEnvelope);
      const objectKey = await writeParquetPartition(source, scope, dt, events);
      logger.info({ objectKey, count: group.length }, 'wrote parquet partition');
      for (const r of group) compactedIds.push(r.id);
    }

    const now = new Date().toISOString();
    for (const chunk of chunked(compactedIds, 200)) {
      const { error: upErr } = await sb
        .from('events')
        .update({ compacted_at: now })
        .in('id', chunk);
      if (upErr) throw new Error(`compaction mark failed: ${upErr.message}`);
    }

    logger.info({ total: compactedIds.length, groups: groups.size }, 'compaction complete');
  } finally {
    await redis.del(LOCK_KEY).catch(() => undefined);
  }
}

function toEnvelope(r: Row): EventEnvelope {
  return {
    eventId: r.event_id,
    source: r.source as EventEnvelope['source'],
    scope: r.scope as EventEnvelope['scope'],
    type: r.type,
    userId: r.user_id,
    sessionId: r.session_id ?? undefined,
    ts: r.ts,
    schemaVersion: r.schema_version,
    data: r.data ?? {},
    context: r.context ?? undefined,
  };
}

function* chunked<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}
