import { getSupabase, getEnv, logger, sign, safeEqual } from '@pandora/core';

export interface AuthContext {
  keyId: string;
  source: string;
}

export type AuthResult =
  | { ok: true; ctx: AuthContext }
  | { ok: false; status: number; reason: string };

interface KeyRecord {
  key_id: string;
  source: string;
  secret: string;
}

const KEY_CACHE_MS = 30_000;
const keyCache = new Map<string, { rec: KeyRecord | null; at: number }>();

async function lookupKey(keyId: string): Promise<KeyRecord | null> {
  const cached = keyCache.get(keyId);
  if (cached && Date.now() - cached.at < KEY_CACHE_MS) return cached.rec;

  const { data, error } = await getSupabase()
    .from('api_keys')
    .select('key_id, source, secret')
    .eq('key_id', keyId)
    .eq('active', true)
    .is('revoked_at', null)
    .maybeSingle();

  if (error) {
    logger.error({ error }, 'api_keys lookup failed');
    return null; // fail closed
  }
  const rec = (data as KeyRecord | null) ?? null;
  keyCache.set(keyId, { rec, at: Date.now() });
  return rec;
}

/**
 * Verify a request: presence of headers, timestamp freshness (anti-replay),
 * known/active key, source match, and HMAC over the RAW body.
 */
export async function authenticate(headers: Headers, rawBody: string): Promise<AuthResult> {
  const keyId = headers.get('x-pandora-key');
  const source = headers.get('x-pandora-source');
  const ts = headers.get('x-pandora-timestamp');
  const signature = headers.get('x-pandora-signature');

  if (!keyId || !source || !ts || !signature) {
    return { ok: false, status: 401, reason: 'missing auth headers' };
  }

  const skew = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(skew) || skew > getEnv().HMAC_MAX_SKEW_SEC) {
    return { ok: false, status: 401, reason: 'stale or invalid timestamp' };
  }

  const rec = await lookupKey(keyId);
  if (!rec) return { ok: false, status: 401, reason: 'unknown or revoked key' };
  if (rec.source !== source) return { ok: false, status: 401, reason: 'source mismatch' };

  const expected = sign(rec.secret, ts, rawBody);
  if (!safeEqual(expected, signature)) {
    return { ok: false, status: 401, reason: 'bad signature' };
  }

  // best-effort, non-blocking
  void getSupabase()
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('key_id', keyId)
    .then(({ error }) => {
      if (error) logger.warn({ error }, 'last_used_at update failed');
    });

  return { ok: true, ctx: { keyId, source } };
}
