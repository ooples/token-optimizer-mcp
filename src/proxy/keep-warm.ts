/**
 * Keeping a large conversation's prompt cache alive across idle gaps.
 *
 * THE COST IT REMOVES. A turn that arrives after the cache entry expired
 * re-writes the whole context: at the one-hour tier that is 2x the context in
 * input tokens, once per return from a break. Measured on one long main session
 * (2026-10-07..21): 54 such returns, 21.3M cache-write tokens, 63% of all its
 * writes, about 394k each.
 *
 * THE PING. Re-sending the exact bytes last sent, with `max_tokens` lowered and
 * streaming off, is a cache READ (0.1x) that renews the entry's lifetime: the
 * cache is matched on the prompt, and neither field is part of it. So holding a
 * P-token context warm for one more lifetime costs ~0.1P, and a return inside it
 * saves ~(write multiplier - 0.1)P -- 1.9P at the one-hour tier. Worth it when a
 * return within the next lifetime is more likely than 0.1/1.9 = 5%.
 *
 * CAPPED, per the user's decision (2026-10-21: "ping while a return is likely",
 * and compact the cold turn when the cache lapsed anyway): a conversation is
 * pinged at most `maxPings` times after its last real turn, only when its
 * context is large enough for a rewrite to matter, and never again once a ping
 * fails or reads nothing back (the entry was already gone). Every ping is
 * reported through `observe`, so its cost is on the same ledger as the turns.
 */
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

/** Below this many bytes sent, a rewrite is too small to be worth holding warm. */
export const MIN_PREFIX_BYTES = 200_000;
/** Pings after the last real turn: at the one-hour tier, three hours covered. */
export const DEFAULT_MAX_PINGS = 3;
/** Fire this long before the entry would expire. */
export const MARGIN_MS = 4 * 60 * 1000;
/**
 * Output a ping may produce: none. `max_tokens: 0` runs prefill only -- the
 * cache read that renews the entry -- and returns `content: []` with zero output
 * tokens billed. It is rejected with `stream: true` (sent off here), a fixed
 * thinking budget (not pinged, see pingBody), structured outputs and a forced
 * tool_choice (both declined below).
 */
export const PING_MAX_TOKENS = 0;

export interface WarmTarget {
  readonly upstream: string;
  readonly path: string;
  readonly headers: Record<string, string | string[]>;
  /** The exact bytes last forwarded for this conversation. */
  readonly body: Buffer;
  readonly ttlMs: number;
}

export interface PingOutcome {
  readonly key: string;
  readonly ok: boolean;
  readonly status: number | null;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly input: number;
  readonly output: number;
  readonly ping: number;
}

interface Entry {
  target: WarmTarget;
  timer: NodeJS.Timeout | null;
  pings: number;
  lastSeen: number;
}

/** The longest cache lifetime any marker in the request asks for (default 5 minutes). */
export function ttlOf(body: Buffer): number {
  const text = body.toString('utf8');
  return /"cache_control":\{[^}]*"ttl":"1h"/.test(text)
    ? 60 * 60 * 1000
    : 5 * 60 * 1000;
}

/**
 * The ping body: the same request, a few output tokens, no stream. Null when it
 * cannot be built.
 *
 * NOT FOR A FIXED THINKING BUDGET (review on #523). The API requires
 * `max_tokens` above `thinking.budget_tokens`, and the thinking parameters are
 * part of what the cache matches, so they cannot be dropped either. Raising
 * `max_tokens` past a 16k budget would let one ping generate up to 16k output
 * tokens, at output price -- so such a conversation is not pinged. Adaptive
 * thinking, which Claude Code sends, has no budget and is pinged.
 */
export function pingBody(body: Buffer): Buffer | null {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    if (!Array.isArray(parsed.messages)) return null;
    const thinking = parsed.thinking as
      | { type?: string; budget_tokens?: number }
      | undefined;
    if (thinking?.type === 'enabled') return null;
    // The other shapes `max_tokens: 0` rejects.
    if ((parsed.output_config as { format?: unknown } | undefined)?.format)
      return null;
    const choice = (parsed.tool_choice as { type?: string } | undefined)?.type;
    if (choice === 'tool' || choice === 'any') return null;
    return Buffer.from(
      JSON.stringify({ ...parsed, max_tokens: PING_MAX_TOKENS, stream: false }),
      'utf8'
    );
  } catch {
    return null;
  }
}

export function keepWarmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no|off)$/i.test(
    String(env.TOKEN_OPTIMIZER_PROXY_KEEPWARM ?? '').trim()
  );
}

export function maxPingsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.TOKEN_OPTIMIZER_PROXY_KEEPWARM_PINGS);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_PINGS;
}

type Sender = (
  target: WarmTarget,
  body: Buffer
) => Promise<{ status: number; json: unknown }>;

/** POSTs a ping and reads the JSON reply. */
const defaultSender: Sender = (target, body) =>
  new Promise((resolve, reject) => {
    const url = new URL(target.path, target.upstream);
    const send = url.protocol === 'http:' ? httpRequest : httpsRequest;
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(target.headers)) {
      const key = k.toLowerCase();
      if (
        key === 'content-length' ||
        key === 'host' ||
        key === 'accept-encoding' ||
        key === 'connection'
      )
        continue;
      headers[k] = v;
    }
    headers['content-length'] = String(body.length);
    headers['accept'] = 'application/json';
    const req = send(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let json: unknown = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(120_000, () =>
      req.destroy(new Error('keep-warm ping timed out'))
    );
    req.end(body);
  });

/** Slack before a cache is called expired: a wrong "expired" rewrites a warm prefix. */
export const EXPIRY_SLACK_MS = 60_000;
/** Conversations whose last-warm time is remembered. */
const MAX_TRACKED = 500;

export class KeepWarm {
  private readonly entries = new Map<string, Entry>();
  /** When each conversation's cache was last made warm (real turn or read-back ping), and its TTL. */
  private readonly lastWarm = new Map<string, { at: number; ttlMs: number }>();

  private touch(key: string, ttlMs: number): void {
    this.lastWarm.delete(key);
    this.lastWarm.set(key, { at: (this.opts.now ?? Date.now)(), ttlMs });
    while (this.lastWarm.size > MAX_TRACKED) {
      const oldest = this.lastWarm.keys().next().value;
      if (oldest === undefined) break;
      this.lastWarm.delete(oldest);
    }
  }

  /**
   * Has this conversation's provider cache certainly expired? False when unknown:
   * only a conversation seen in this process, idle past its TTL plus slack,
   * counts -- a wrong "yes" would rewrite a prefix the provider still holds.
   */
  expired(key: string | null): boolean {
    if (!key) return false;
    const w = this.lastWarm.get(key);
    if (!w) return false;
    return (this.opts.now ?? Date.now)() - w.at > w.ttlMs + EXPIRY_SLACK_MS;
  }

  constructor(
    private readonly opts: {
      maxPings?: number;
      marginMs?: number;
      minPrefixBytes?: number;
      onPing?: (outcome: PingOutcome) => void;
      sender?: Sender;
      now?: () => number;
    } = {}
  ) {}

  /** A real turn of `key` was just answered; (re)arm its ping. */
  seen(key: string | null, target: WarmTarget): void {
    if (!key) return;
    this.touch(key, target.ttlMs);
    const existing = this.entries.get(key);
    if (existing?.timer) clearTimeout(existing.timer);
    if (
      target.body.length < (this.opts.minPrefixBytes ?? MIN_PREFIX_BYTES) ||
      (this.opts.maxPings ?? DEFAULT_MAX_PINGS) === 0
    ) {
      this.entries.delete(key);
      return;
    }
    const entry: Entry = {
      target,
      timer: null,
      pings: 0,
      lastSeen: (this.opts.now ?? Date.now)(),
    };
    this.entries.set(key, entry);
    this.arm(key, entry);
  }

  private arm(key: string, entry: Entry): void {
    const delay = Math.max(
      1000,
      entry.target.ttlMs - (this.opts.marginMs ?? MARGIN_MS)
    );
    entry.timer = setTimeout(() => void this.fire(key, entry), delay);
    entry.timer.unref?.();
  }

  private async fire(key: string, entry: Entry): Promise<void> {
    if (this.entries.get(key) !== entry) return; // a newer real turn replaced it
    const body = pingBody(entry.target.body);
    if (!body) return void this.entries.delete(key);
    entry.pings += 1;
    let outcome: PingOutcome;
    try {
      const { status, json } = await (this.opts.sender ?? defaultSender)(
        entry.target,
        body
      );
      const u = ((json as { usage?: Record<string, number> } | null)?.usage ??
        {}) as Record<string, number>;
      outcome = {
        key,
        ok: status === 200,
        status,
        ping: entry.pings,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
      };
    } catch {
      outcome = {
        key,
        ok: false,
        status: null,
        ping: entry.pings,
        cacheRead: 0,
        cacheWrite: 0,
        input: 0,
        output: 0,
      };
    }
    this.opts.onPing?.(outcome);
    // A ping that read the prefix back renewed the entry's lifetime.
    if (outcome.ok && outcome.cacheRead > 0)
      this.touch(key, entry.target.ttlMs);
    if (this.entries.get(key) !== entry) return;
    // A failed ping, or one that read nothing back, means the entry is gone: stop paying.
    if (
      !outcome.ok ||
      outcome.cacheRead === 0 ||
      entry.pings >= (this.opts.maxPings ?? DEFAULT_MAX_PINGS)
    ) {
      this.entries.delete(key);
      return;
    }
    this.arm(key, entry);
  }

  /** Conversations currently held warm. */
  size(): number {
    return this.entries.size;
  }

  stop(): void {
    for (const e of this.entries.values()) if (e.timer) clearTimeout(e.timer);
    this.entries.clear();
  }
}
