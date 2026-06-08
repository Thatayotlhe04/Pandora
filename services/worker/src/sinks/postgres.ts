import { getSupabase } from '@pandora/core';
import type { EventEnvelope } from '@pandora/schema';

function toRow(e: EventEnvelope) {
  return {
    event_id: e.eventId,
    source: e.source,
    scope: e.scope,
    type: e.type,
    user_id: e.userId,
    session_id: e.sessionId ?? null,
    ts: e.ts,
    schema_version: e.schemaVersion,
    data: e.data ?? {},
    context: e.context ?? {},
  };
}

/**
 * Hot write, batched. One multi-row upsert per flush instead of one request per
 * event — the main efficiency lever on the ingest path. Idempotent on event_id
 * (ignoreDuplicates), so replays and retries are safe.
 */
export async function insertEvents(events: EventEnvelope[]): Promise<void> {
  if (events.length === 0) return;
  const { error } = await getSupabase()
    .from('events')
    .upsert(events.map(toRow), { onConflict: 'event_id', ignoreDuplicates: true });
  if (error) throw new Error(`events upsert failed: ${error.message}`);
}

/** Single-event convenience (delegates to the batched path). */
export async function insertEvent(e: EventEnvelope): Promise<void> {
  await insertEvents([e]);
}
