import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Supabase (hot store) — service role
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Upstash Redis (BullMQ)
  REDIS_URL: z.string().min(1),

  // Cloudflare R2 (cold store)
  R2_ENDPOINT: z.string().url(),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1).default('pandora-lake'),

  // Service
  PORT: z.coerce.number().int().positive().default(8787),
  INGEST_MAX_BATCH: z.coerce.number().int().positive().default(500),
  HMAC_MAX_SKEW_SEC: z.coerce.number().int().positive().default(300),
  COMPACTION_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  COMPACTION_BATCH: z.coerce.number().int().positive().default(5_000),
  LOG_LEVEL: z.string().default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/** Parse and cache process.env. Throws a readable error if anything is missing. */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${detail}`);
  }
  cached = parsed.data;
  return cached;
}
