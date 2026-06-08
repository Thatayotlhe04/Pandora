import { EventEnvelope, type EventEnvelope as Event } from './envelope.js';
import { lookupPayloadSchema } from './vocab.js';

export * from './envelope.js';
export * from './vocab.js';

/**
 * Fields that are unambiguously raw content (never legitimate metadata). Under
 * product_improvement scope these are rejected; ops metrics stay internal and
 * raw content only ships under model_training unless the user has opted out.
 */
const CONTENT_KEYS = ['text', 'body', 'transcript', 'prompt', 'response', 'completion'] as const;

export type ValidationResult =
  | { ok: true; event: Event; known: boolean }
  | { ok: false; stage: 'envelope' | 'payload' | 'scope'; reason: string; path?: string };

/**
 * Validate an unknown input: envelope → payload (if the type is registered) →
 * scope/content guard. Returns a typed event on success.
 */
export function validateEvent(input: unknown): ValidationResult {
  const env = EventEnvelope.safeParse(input);
  if (!env.success) {
    const issue = env.error.issues[0];
    return {
      ok: false,
      stage: 'envelope',
      reason: issue?.message ?? 'invalid envelope',
      path: issue?.path.join('.'),
    };
  }

  const event = env.data;

  const payloadSchema = lookupPayloadSchema(event.source, event.type);
  let known = false;
  if (payloadSchema) {
    const payload = payloadSchema.safeParse(event.data);
    if (!payload.success) {
      const issue = payload.error.issues[0];
      const path = `data.${issue?.path.join('.') ?? ''}`;
      return { ok: false, stage: 'payload', reason: `${path}: ${issue?.message ?? 'invalid'}`, path };
    }
    known = true;
  }

  // content guard: product_improvement is metadata-only
  if (event.scope === 'product_improvement') {
    for (const key of CONTENT_KEYS) {
      const v = event.data[key];
      if (typeof v === 'string' && v.length > 0) {
        return {
          ok: false,
          stage: 'scope',
          reason: `content field '${key}' not allowed under product_improvement (use model_training unless opted out)`,
          path: `data.${key}`,
        };
      }
    }
  }

  return { ok: true, event, known };
}
