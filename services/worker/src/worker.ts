import { Worker, Queue, type Job } from 'bullmq';
import { getRedis, getSupabase, getEnv, logger } from '@pandora/core';
import type { EventEnvelope } from '@pandora/schema';
import { WriteBatcher } from './batcher.js';
import { runCompaction } from './compaction.js';

const INGEST_QUEUE = 'pandora:ingest';
const MAINT_QUEUE = 'pandora:maintenance';

async function recordDeadLetter(job: Job<EventEnvelope>, err: Error): Promise<void> {
  const { error } = await getSupabase()
    .from('rejections')
    .insert({
      event_id: job.data?.eventId ?? null,
      source: job.data?.source ?? null,
      type: job.data?.type ?? null,
      stage: 'processing',
      reason: err.message.slice(0, 1000),
      raw: job.data ?? {},
    });
  if (error) logger.warn({ error }, 'failed to record dead-letter rejection');
}

async function main(): Promise<void> {
  getEnv(); // validate env up front
  const connection = getRedis();
  const batcher = new WriteBatcher(100, 200);

  // High concurrency feeds the batcher fast; the batcher collapses the writes.
  const ingestWorker = new Worker<EventEnvelope>(
    INGEST_QUEUE,
    (job) => batcher.add(job.data),
    { connection, concurrency: 100 }
  );

  ingestWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'ingest job failed');
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void recordDeadLetter(job, err);
    }
  });

  const maintWorker = new Worker(
    MAINT_QUEUE,
    async (job) => {
      if (job.name === 'compact') await runCompaction();
    },
    { connection, concurrency: 1 }
  );
  maintWorker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err: err.message }, 'maintenance job failed')
  );

  const maintQueue = new Queue(MAINT_QUEUE, { connection });
  await maintQueue.add(
    'compact',
    {},
    {
      repeat: { every: getEnv().COMPACTION_INTERVAL_MS },
      removeOnComplete: true,
      removeOnFail: 100,
    }
  );

  logger.info('pandora worker up (batched ingest + maintenance)');

  const shutdown = async (): Promise<void> => {
    logger.info('shutting down worker');
    await batcher.flush();
    await Promise.allSettled([ingestWorker.close(), maintWorker.close(), maintQueue.close()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  logger.error({ err: String(err) }, 'worker failed to start');
  process.exit(1);
});
