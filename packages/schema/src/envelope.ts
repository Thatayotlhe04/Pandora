import { z } from 'zod';

export const SOURCES = ['nubia', 'nimbus', 'primedrive', 'monolith', 'prototype'] as const;
export const SCOPES = ['product_improvement', 'model_training'] as const;

export const Source = z.enum(SOURCES);
export const Scope = z.enum(SCOPES);

export const SCHEMA_VERSION = 1;

/**
 * The master envelope. Every event satisfies this regardless of its `data`
 * payload. `eventId` is the idempotency key (deduped at the queue and at the
 * unique constraint in Postgres). `userId` is a pseudonymous id — never PII.
 */
export const EventEnvelope = z.object({
  eventId: z.string().uuid(),
  source: Source,
  scope: Scope,
  type: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9]+(?:[._][a-z0-9]+)*$/, 'type must be lower.snake.dotted'),
  userId: z.string().min(1).max(256),
  sessionId: z.string().max(256).optional(),
  ts: z.string().datetime({ offset: true }),
  schemaVersion: z.number().int().positive().default(SCHEMA_VERSION),
  data: z.record(z.string(), z.unknown()).default({}),
  context: z
    .object({
      sdkVersion: z.string().optional(),
      lib: z.string().optional(),
      ip: z.string().optional(),
      userAgent: z.string().optional(),
    })
    .partial()
    .optional(),
});

export type EventEnvelope = z.infer<typeof EventEnvelope>;
export type SourceName = z.infer<typeof Source>;
export type ScopeName = z.infer<typeof Scope>;
