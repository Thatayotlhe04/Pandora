import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Canonical request signature. MUST stay byte-identical to the copy in
 * @pandora/tracker, or the SDK and the ingestion API won't agree.
 *
 * signature = "sha256=" + HMAC_SHA256(secret, `${timestamp}.${body}`)
 */
export function sign(secret: string, timestamp: string, body: string): string {
  const mac = createHmac('sha256', secret);
  mac.update(`${timestamp}.${body}`);
  return `sha256=${mac.digest('hex')}`;
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
