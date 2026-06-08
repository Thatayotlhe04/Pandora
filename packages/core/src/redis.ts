import { Redis } from 'ioredis';
import { getEnv } from './env.js';

let connection: Redis | null = null;

/**
 * Shared ioredis connection for BullMQ. `maxRetriesPerRequest: null` is
 * required by BullMQ's blocking commands. Works with Upstash over the
 * rediss:// TLS URL (mind the free-tier daily command quota — BullMQ polls).
 */
export function getRedis(): Redis {
  if (connection) return connection;
  const { REDIS_URL } = getEnv();
  connection = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  return connection;
}
