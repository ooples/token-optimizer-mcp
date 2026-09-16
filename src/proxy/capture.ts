/**
 * Recording real request bodies, so the compressor can be measured on the
 * content it actually removes.
 *
 * WHY THIS HAD TO EXIST. Every offline evaluation in this repository runs on
 * Claude Code session transcripts, and those store `thinking: ""` -- the
 * reasoning text is discarded and only the signature is kept. Measured across
 * three real sessions: 710 thinking blocks carrying 0 bytes of text against
 * 1.7MB of signature. So an evidence-survival run over transcripts removes
 * cryptographic noise and reports a flawless score that means nothing, which is
 * exactly what happened before this file existed.
 *
 * The proxy is the one place the real bytes pass through. Nothing else on this
 * machine sees a request with its reasoning intact.
 *
 * THIS DELIBERATELY BREAKS A PROMISE THE PROXY OTHERWISE MAKES, and that is why
 * it is shaped the way it is. `server.ts` states that it will not store, log or
 * persist a payload. Capture writes conversation content to disk, so:
 *
 *   - it is OFF unless a directory is named, never a boolean;
 *   - it announces itself on stderr at startup, every time, naming the path;
 *   - it writes only the REQUEST, because that is what the measurement needs;
 *   - it is documented as a benchmarking tool rather than a feature.
 *
 * A capture directory is conversation content in plaintext. Treat it the way
 * you would treat the transcript it came from.
 */

import { mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// Serialize writes per destination so concurrent requests cannot interleave
// JSONL records. Settled queues are released, including after a failed write.
const pending = new Map<string, Promise<boolean>>();
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 128;
const CHUNK_BYTES = 64 * 1024;
let pendingBytes = 0;
let pendingRequests = 0;
let writers = 0;
const waitingWriters: (() => void)[] = [];
async function acquireWriter(): Promise<void> {
  if (writers >= 2)
    await new Promise<void>((resolve) => waitingWriters.push(resolve));
  else writers++;
}
function releaseWriter(): void {
  const next = waitingWriters.shift();
  if (next) next();
  else writers--;
}

/** Where to write captures, or null when capture is off. */
export function captureDir(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const raw = env.TOKEN_OPTIMIZER_PROXY_CAPTURE;
  if (typeof raw !== 'string') return null;
  const dir = raw.trim();
  // A BOOLEAN WOULD BE WRONG HERE. Writing conversation content to a default
  // location because someone set a flag to `1` is the failure this shape rules
  // out: the operator has to say WHERE, which means they have decided to keep
  // it somewhere specific.
  if (!dir || /^(0|false|no|off|1|true|yes|on)$/i.test(dir)) return null;
  return dir;
}

/**
 * Appends one request body to the capture log.
 *
 * Returns false on failure; the server warns once without failing the request. A capture
 * directory that cannot be created, a disk that is full, a permissions error --
 * none of them is a reason to fail the request the user is waiting on. The
 * measurement is an optimisation on top of a working proxy. The global queue
 * admits at most 128 requests / 16 MiB of snapshots and metadata; excess
 * captures return false before copying the input.
 *
 * One JSON object per line: the request as it ARRIVED, before compression,
 * because the whole point is to measure what compression would remove from it.
 */
export function captureRequest(
  dir: string,
  path: string,
  body: Buffer
): Promise<boolean> {
  const destination = resolve(dir);
  const reserved = body.length + 2 * (path.length + destination.length) + 128;
  // Reserve before copying or encoding. Slow disks must not retain an unbounded
  // number of expanded JSON strings, including across different destinations.
  if (
    reserved > MAX_PENDING_BYTES - pendingBytes ||
    pendingRequests >= MAX_PENDING_REQUESTS
  )
    return Promise.resolve(false);
  pendingBytes += reserved;
  pendingRequests++;
  const at = Date.now();
  let snapshot: Buffer;
  try {
    snapshot = Buffer.from(body);
  } catch {
    pendingBytes -= reserved;
    pendingRequests--;
    return Promise.resolve(false);
  }
  const write = (pending.get(destination) ?? Promise.resolve(true)).then(
    async () => {
      await acquireWriter();
      try {
        await mkdir(destination, { recursive: true });
        const file = await open(join(destination, 'requests.jsonl'), 'a');
        try {
          const prefix = `${JSON.stringify({ at, path }).slice(0, -1)},"body":"`;
          const decoder = new StringDecoder('utf8');
          if (!snapshot.length) await file.writeFile(prefix + '"}\n');
          // Bound transient UTF-16/escaped strings as well as the queued input.
          // StringDecoder preserves characters split across UTF-8 chunk edges.
          for (
            let offset = 0;
            offset < snapshot.length;
            offset += CHUNK_BYTES
          ) {
            let text = decoder.write(
              snapshot.subarray(offset, offset + CHUNK_BYTES)
            );
            const last = offset + CHUNK_BYTES >= snapshot.length;
            if (last) text += decoder.end();
            await file.writeFile(
              (offset === 0 ? prefix : '') +
                JSON.stringify(text).slice(1, -1) +
                (last ? '"}\n' : '')
            );
          }
        } finally {
          await file.close();
        }
        return true;
      } catch {
        return false;
      } finally {
        releaseWriter();
        pendingBytes -= reserved;
        pendingRequests--;
      }
    }
  );
  pending.set(destination, write);
  void write.then(() => {
    if (pending.get(destination) === write) pending.delete(destination);
  });
  return write;
}

/** The line printed at startup when capture is on. Never omitted. */
export function captureNotice(dir: string): string {
  return (
    `token-optimizer proxy: CAPTURING REQUEST BODIES to ${join(dir, 'requests.jsonl')}\n` +
    '  This writes conversation content, including reasoning, to disk in plaintext.\n' +
    '  It is a benchmarking tool. Unset TOKEN_OPTIMIZER_PROXY_CAPTURE to stop.'
  );
}
