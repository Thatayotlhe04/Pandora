import { Queue } from 'bullmq';
import { getRedis } from '@pandora/core';
import type { EventEnvelope } from '@pandora/schema';

export const INGEST_QUEUE = 'pandora:ingest';

let queue: Queue<EventEnvelope> | null = null;

export function getIngestQueue(): Queue<EventEnvelope> {
  if (queue) return queue;
  queue = new Queue<EventEnvelope>(INGEST_QUEUE, {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600, count: 10_000 },
      removeOnFail: { age: 24 * 3600 },
    },
  });
  return queue;
}

/**
 * Enqueue validated events. jobId = eventId gives queue-level dedupe: a repeated
 * event (SDK retry, replay) is ignored. Postgres' unique constraint is the
 * second line of defence.
 */
export async function enqueueEvents(events: EventEnvelope[]): Promise<void> {
  const q = getIngestQueue();
  await q.addBulk(
    events.map((e) => ({
      name: e.type,
      data: e,
      opts: { jobId: e.eventId },
    }))
  );
}
