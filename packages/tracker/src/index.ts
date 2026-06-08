import { createHmac, randomUUID } from 'node:crypto';

/**
 * @pandora/tracker — server-side event SDK.
 *
 * SERVER-SIDE ONLY. The secret signs requests; never ship it to a browser.
 * Client-originated events should flow through your source's backend, which
 * calls this SDK.
 *
 * Guarantees:
 *  - every event is tagged with a scope; model_training is default-on and
 *    stops shipping once the user opts out (resolved from your own store)
 *  - events are batched and flushed on size/interval
 *  - transient failures retry with exponential backoff; exhausted batches are
 *    requeued for the next flush/close
 *  - track() never throws into the host application
 */

export const SCOPES = {
  PRODUCT_IMPROVEMENT: 'product_improvement',
  MODEL_TRAINING: 'model_training',
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

export interface TrackerConfig {
  /** Source id, e.g. 'nubia'. Must match the api key's source. */
  source: string;
  /** Ingestion base URL, e.g. https://ingest.pandora.dev */
  endpoint: string;
  /** Public key id: pk_<source>_xxx */
  keyId: string;
  /** HMAC secret. Server-side only. */
  secret: string;
  /**
   * Returns the scopes currently allowed for a user, after opt-outs.
   * If omitted, both scopes are allowed by default; pass this in production so
   * revocations are honored.
   */
  resolveConsent?: (userId: string) => Promise<string[]> | string[];
  /** Scopes allowed when no resolver is configured. Defaults to both scopes. */
  defaultScopes?: Scope[];
  batchSize?: number;
  flushIntervalMs?: number;
  maxRetries?: number;
  consentCacheMs?: number;
  onError?: (err: unknown, context: string) => void;
  /** Override fetch (tests / non-global-fetch runtimes). */
  fetchImpl?: typeof fetch;
}

export interface TrackInput {
  userId: string;
  scope: Scope;
  /** lower.snake.dotted, e.g. 'study_session.completed' */
  type: string;
  data?: Record<string, unknown>;
  sessionId?: string;
  /** ISO timestamp; defaults to now. */
  ts?: string;
}

interface ResolvedConfig {
  source: string;
  endpoint: string;
  keyId: string;
  secret: string;
  resolveConsent: TrackerConfig['resolveConsent'];
  defaultScopes: Scope[];
  batchSize: number;
  flushIntervalMs: number;
  maxRetries: number;
  consentCacheMs: number;
  onError?: TrackerConfig['onError'];
}

interface QueuedEvent {
  eventId: string;
  source: string;
  scope: Scope;
  type: string;
  userId: string;
  sessionId?: string;
  ts: string;
  schemaVersion: number;
  data: Record<string, unknown>;
  context: { sdkVersion: string; lib: string };
}

const LIB = '@pandora/tracker';
const VERSION = '0.3.0';

export class Tracker {
  private cfg: ResolvedConfig;
  private queue: QueuedEvent[] = [];
  private consentCache = new Map<string, { scopes: Set<string>; at: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private fetchImpl: typeof fetch;
  private closed = false;

  constructor(config: TrackerConfig) {
    if (!config.source) throw new Error('tracker: source required');
    if (!config.endpoint) throw new Error('tracker: endpoint required');
    if (!config.keyId) throw new Error('tracker: keyId required');
    if (!config.secret) throw new Error('tracker: secret required');
    this.cfg = {
      source: config.source,
      endpoint: config.endpoint.replace(/\/$/, ''),
      keyId: config.keyId,
      secret: config.secret,
      resolveConsent: config.resolveConsent,
      defaultScopes: config.defaultScopes ?? Object.values(SCOPES),
      batchSize: config.batchSize ?? 50,
      flushIntervalMs: config.flushIntervalMs ?? 5000,
      maxRetries: config.maxRetries ?? 5,
      consentCacheMs: config.consentCacheMs ?? 60_000,
      onError: config.onError,
    };

    const f = config.fetchImpl ?? globalThis.fetch;
    if (!f) throw new Error('tracker: no fetch implementation available (Node 18+ or pass fetchImpl)');
    this.fetchImpl = f;

    this.timer = setInterval(() => {
      void this.flush();
    }, this.cfg.flushIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Queue an event. Returns false if dropped (opted out / invalid / closed). */
  async track(input: TrackInput): Promise<boolean> {
    try {
      if (this.closed) return false;
      if (!input || !input.userId || !input.type || !input.scope) return false;
      if (!Object.values(SCOPES).includes(input.scope)) return false;

      const allowed = await this.scopesFor(input.userId);
      if (!allowed.has(input.scope)) return false; // opted out -> drop

      this.queue.push({
        eventId: randomUUID(),
        source: this.cfg.source,
        scope: input.scope,
        type: input.type,
        userId: input.userId,
        sessionId: input.sessionId,
        ts: input.ts ?? new Date().toISOString(),
        schemaVersion: 1,
        data: input.data ?? {},
        context: { sdkVersion: VERSION, lib: LIB },
      });

      if (this.queue.length >= this.cfg.batchSize) await this.flush();
      return true;
    } catch (err) {
      this.cfg.onError?.(err, 'track');
      return false;
    }
  }

  private async scopesFor(userId: string): Promise<Set<string>> {
    const cached = this.consentCache.get(userId);
    if (cached && Date.now() - cached.at < this.cfg.consentCacheMs) return cached.scopes;
    const resolvedScopes = this.cfg.resolveConsent
      ? await this.cfg.resolveConsent(userId)
      : this.cfg.defaultScopes;
    const scopes = new Set(resolvedScopes);
    this.consentCache.set(userId, { scopes, at: Date.now() });
    return scopes;
  }

  /** Send all queued events. Safe to call manually. */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    const body = JSON.stringify({ events: batch });

    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      try {
        const res = await this.send(body);
        if (res.ok) return;
        // permanent client errors (except rate limit): don't spin forever
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          this.cfg.onError?.(new Error(`ingest rejected ${res.status}`), 'flush.permanent');
          return;
        }
      } catch (err) {
        this.cfg.onError?.(err, `flush.attempt.${attempt}`);
      }

      if (attempt < this.cfg.maxRetries) {
        await delay(backoffMs(attempt));
      } else {
        this.queue.unshift(...batch); // requeue for a later attempt
        this.cfg.onError?.(new Error('ingest failed after retries'), 'flush.exhausted');
      }
    }
  }

  private send(body: string): Promise<Response> {
    const ts = Math.floor(Date.now() / 1000).toString();
    const signature = sign(this.cfg.secret, ts, body);
    return this.fetchImpl(`${this.cfg.endpoint}/ingest/batch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pandora-key': this.cfg.keyId,
        'x-pandora-source': this.cfg.source,
        'x-pandora-timestamp': ts,
        'x-pandora-signature': signature,
      },
      body,
    });
  }

  /** Flush and stop the timer. Call on graceful shutdown. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.closed = true;
    await this.flush();
  }
}

/**
 * Request signature. MUST match @pandora/core sign().
 * signature = "sha256=" + HMAC_SHA256(secret, `${timestamp}.${body}`)
 */
export function sign(secret: string, timestamp: string, body: string): string {
  const mac = createHmac('sha256', secret);
  mac.update(`${timestamp}.${body}`);
  return `sha256=${mac.digest('hex')}`;
}

function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** attempt);
  return base + Math.floor(Math.random() * 250);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── module-level convenience singleton ──────────────────────────────────────
let singleton: Tracker | null = null;

export function init(config: TrackerConfig): Tracker {
  singleton = new Tracker(config);
  return singleton;
}

export function track(input: TrackInput): Promise<boolean> {
  if (!singleton) throw new Error('tracker: call init() before track()');
  return singleton.track(input);
}

export function flush(): Promise<void> {
  return singleton ? singleton.flush() : Promise.resolve();
}
