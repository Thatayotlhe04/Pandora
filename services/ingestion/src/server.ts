import { Hono } from 'hono';
import { logger, getEnv, getSupabase } from '@pandora/core';
import { validateEvent } from '@pandora/schema';
import { authenticate } from './auth.js';
import { enqueueEvents } from './queue.js';

export const app = new Hono();

app.get('/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

app.post('/ingest', async (c) => {
  const raw = await c.req.text();
  const auth = await authenticate(c.req.raw.headers, raw);
  if (!auth.ok) return c.json({ error: auth.reason }, auth.status as 401);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }

  const result = await handleEvents([parsed], auth.ctx.source);
  const status = result.accepted === 0 && result.rejected > 0 ? 400 : 202;
  return c.json(result, status);
});

app.post('/ingest/batch', async (c) => {
  const raw = await c.req.text();
  const auth = await authenticate(c.req.raw.headers, raw);
  if (!auth.ok) return c.json({ error: auth.reason }, auth.status as 401);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }

  const events = Array.isArray(parsed)
    ? parsed
    : (parsed as { events?: unknown })?.events;
  if (!Array.isArray(events)) {
    return c.json({ error: 'expected an array, or { events: [...] }' }, 400);
  }

  const max = getEnv().INGEST_MAX_BATCH;
  if (events.length > max) {
    return c.json({ error: `batch too large (max ${max})` }, 413);
  }

  const result = await handleEvents(events, auth.ctx.source);
  const status = result.accepted === 0 && result.rejected > 0 ? 400 : 202;
  return c.json(result, status);
});

app.onError((err, c) => {
  logger.error({ err: String(err) }, 'unhandled ingestion error');
  return c.json({ error: 'internal error' }, 500);
});

interface IngestResult {
  accepted: number;
  rejected: number;
  errors: Array<{ index: number; eventId?: string; stage: string; reason: string }>;
}

interface RejectionRow {
  event_id: string | null;
  source: string | null;
  type: string | null;
  stage: 'validation';
  reason: string;
  raw: unknown;
}

/**
 * Validate every event, enqueue the good ones, log the bad ones. Partial
 * success: a bad event in a batch never blocks the good ones. A key may only
 * write events for its own source.
 */
async function handleEvents(rawEvents: unknown[], sourceFromKey: string): Promise<IngestResult> {
  const valid = [];
  const errors: IngestResult['errors'] = [];
  const rejections: RejectionRow[] = [];

  for (let i = 0; i < rawEvents.length; i++) {
    const raw = rawEvents[i];
    const r = validateEvent(raw);

    if (!r.ok) {
      const reason = `${r.stage}: ${r.reason}`;
      errors.push({ index: i, stage: r.stage, reason });
      rejections.push({
        event_id: getField(raw, 'eventId'),
        source: getField(raw, 'source'),
        type: getField(raw, 'type'),
        stage: 'validation',
        reason,
        raw: truncate(raw),
      });
      continue;
    }

    if (r.event.source !== sourceFromKey) {
      const reason = `source mismatch: key=${sourceFromKey} event=${r.event.source}`;
      errors.push({ index: i, eventId: r.event.eventId, stage: 'auth', reason });
      rejections.push({
        event_id: r.event.eventId,
        source: r.event.source,
        type: r.event.type,
        stage: 'validation',
        reason,
        raw: truncate(raw),
      });
      continue;
    }

    valid.push(r.event);
  }

  if (valid.length) await enqueueEvents(valid);

  if (rejections.length) {
    void getSupabase()
      .from('rejections')
      .insert(rejections)
      .then(({ error }) => {
        if (error) logger.warn({ error }, 'failed to persist rejections');
      });
  }

  return { accepted: valid.length, rejected: errors.length, errors: errors.slice(0, 50) };
}

function getField(obj: unknown, key: string): string | null {
  if (obj && typeof obj === 'object' && key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : null;
  }
  return null;
}

function truncate(obj: unknown): unknown {
  const s = JSON.stringify(obj);
  if (s.length <= 4000) return obj;
  return { _truncated: true, preview: s.slice(0, 4000) };
}
