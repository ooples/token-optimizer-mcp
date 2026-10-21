/**
 * Single-flight for the first request of sibling agents.
 *
 * Parallel subagents start within a second of each other with the same tools,
 * system blocks and leading context. Sent together, every one of them misses
 * the cache and writes that prefix at 1.25x; measured on the campaign run, two
 * workers starting in the same second each wrote 42k tokens with nothing read,
 * and on the harness one sibling of four regularly wrote 17.3k where the others
 * wrote 9.1k. A cache entry becomes readable once the response that wrote it
 * has begun, so the first request goes out alone and its siblings follow the
 * moment its response headers arrive -- they read what it wrote.
 *
 * BOUNDED: a follower waits at most MAX_WAIT_MS, and a leader that fails or
 * never answers releases its followers, so the worst case is the old behaviour
 * plus a capped delay. Only first requests are gated (a conversation's later
 * turns already share their own prefix), and only while a leader for the same
 * prefix is actually in flight.
 */
import { createHash } from 'node:crypto';

/** Longest a follower is held. Time-to-first-byte is normally 1-4 s. */
export const MAX_WAIT_MS = 12_000;

interface Flight {
  readonly release: () => void;
  readonly done: Promise<void>;
}

const flights = new Map<string, Flight>();

/**
 * The prefix identity of a conversation's FIRST request, or null when it is
 * not one (or is too large to be worth parsing on this path).
 *
 * Everything up to the last block of the first user turn: tools, system and
 * the shared leading blocks -- the task block itself is what differs.
 */
export function coldKey(body: Buffer, maxBytes = 400_000): string | null {
  if (body.length > maxBytes) return null;
  let parsed: {
    tools?: unknown;
    system?: unknown;
    messages?: { role?: string; content?: unknown }[];
  };
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  const messages = parsed?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 3)
    return null;
  if (messages.some((m) => m?.role === 'assistant')) return null;
  const first = messages[0]?.content;
  const leading = Array.isArray(first) ? first.slice(0, -1) : [];
  if (leading.length === 0) return null;
  return createHash('sha256')
    .update(
      JSON.stringify([parsed.tools ?? null, parsed.system ?? null, leading])
    )
    .digest('hex')
    .slice(0, 24);
}

/**
 * Wait, if a leader for this prefix is in flight; otherwise become the leader.
 *
 * @returns `release`, to be called when this request's response headers arrive
 *          (or it fails). A follower's release is a no-op.
 */
export async function enterColdGate(
  key: string | null,
  maxWaitMs = MAX_WAIT_MS
): Promise<{ release: () => void; waitedMs: number }> {
  if (!key) return { release: () => {}, waitedMs: 0 };
  const leader = flights.get(key);
  if (leader) {
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      leader.done,
      new Promise<void>((r) => {
        timer = setTimeout(r, maxWaitMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return { release: () => {}, waitedMs: Date.now() - started };
  }
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = () => {
      if (flights.get(key)?.done === done) flights.delete(key);
      resolve();
    };
  });
  // A leader that never calls back must not hold its siblings past the cap.
  const guard = setTimeout(release, maxWaitMs);
  guard.unref?.();
  flights.set(key, { release, done });
  return {
    release: () => {
      clearTimeout(guard);
      release();
    },
    waitedMs: 0,
  };
}

/** TOKEN_OPTIMIZER_PROXY_COLD_GATE=0 turns it off. */
export function coldGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no|off)$/i.test(
    String(env.TOKEN_OPTIMIZER_PROXY_COLD_GATE ?? '').trim()
  );
}

/** For tests. */
export function inFlightCount(): number {
  return flights.size;
}
