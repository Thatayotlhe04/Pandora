import type { EventEnvelope } from '@pandora/schema';
import { insertEvents } from './sinks/postgres.js';
import { logger } from '@pandora/core';

interface Pending {
  event: EventEnvelope;
  resolve: () => void;
  reject: (err: unknown) => void;
}

/**
 * Coalesces events from concurrent BullMQ job handlers into a single multi-row
 * write. A job's handler awaits add(); its promise settles when the flush that
 * includes it succeeds (resolve → job done) or fails (reject → BullMQ retries,
 * idempotent on event_id). Flushes on size or after maxWaitMs.
 */
export class WriteBatcher {
  private buf: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(
    private readonly maxBatch = 100,
    private readonly maxWaitMs = 200
  ) {}

  add(event: EventEnvelope): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.buf.push({ event, resolve, reject });
      if (this.buf.length >= this.maxBatch) void this.flush();
      else this.scheduleFlush();
    });
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), this.maxWaitMs);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.flushing || this.buf.length === 0) return;
    this.flushing = true;

    const items = this.buf.splice(0, this.buf.length);
    try {
      await insertEvents(items.map((i) => i.event));
      for (const i of items) i.resolve();
    } catch (err) {
      logger.error({ err: String(err), count: items.length }, 'batch flush failed');
      for (const i of items) i.reject(err);
    } finally {
      this.flushing = false;
      if (this.buf.length > 0) this.scheduleFlush();
    }
  }
}
