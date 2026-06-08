import { ParquetSchema, ParquetWriter } from '@dsnp/parquetjs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import { putObject } from '@pandora/core';
import type { EventEnvelope } from '@pandora/schema';

// Envelope columns are typed; flexible payloads ride along as JSON strings.
// SNAPPY keeps the columnar files small without a native build step.
const schema = new ParquetSchema({
  event_id: { type: 'UTF8', compression: 'SNAPPY' },
  source: { type: 'UTF8', compression: 'SNAPPY' },
  scope: { type: 'UTF8', compression: 'SNAPPY' },
  type: { type: 'UTF8', compression: 'SNAPPY' },
  user_id: { type: 'UTF8', compression: 'SNAPPY' },
  session_id: { type: 'UTF8', optional: true, compression: 'SNAPPY' },
  ts: { type: 'TIMESTAMP_MILLIS', compression: 'SNAPPY' },
  schema_version: { type: 'INT32', compression: 'SNAPPY' },
  data: { type: 'UTF8', compression: 'SNAPPY' },
  context: { type: 'UTF8', compression: 'SNAPPY' },
});

/**
 * Write a batch of same-(source, scope, date) events as one Parquet object.
 * Key: <source>/<scope>/dt=<YYYY-MM-DD>/<ts>-<uuid>.parquet
 * Scope is in the path so model_training data stays physically separable.
 */
export async function writeParquetPartition(
  source: string,
  scope: string,
  dt: string,
  events: EventEnvelope[]
): Promise<string> {
  const buffer = await encodeParquet(events);
  const key = `${source}/${scope}/dt=${dt}/${Date.now()}-${randomUUID()}.parquet`;
  await putObject(key, buffer, 'application/vnd.apache.parquet');
  return key;
}

async function encodeParquet(events: EventEnvelope[]): Promise<Buffer> {
  const path = join(tmpdir(), `pandora-${randomUUID()}.parquet`);
  const writer = await ParquetWriter.openFile(schema, path);
  try {
    for (const e of events) {
      await writer.appendRow({
        event_id: e.eventId,
        source: e.source,
        scope: e.scope,
        type: e.type,
        user_id: e.userId,
        session_id: e.sessionId ?? null,
        ts: new Date(e.ts),
        schema_version: e.schemaVersion,
        data: JSON.stringify(e.data ?? {}),
        context: JSON.stringify(e.context ?? {}),
      });
    }
  } finally {
    await writer.close();
  }
  const buf = await readFile(path);
  await unlink(path).catch(() => undefined);
  return buf;
}
