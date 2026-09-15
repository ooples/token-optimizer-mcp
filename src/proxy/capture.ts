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

import { appendFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Serialize writes per destination so concurrent requests cannot interleave
// JSONL records. Settled queues are released, including after a failed write.
const pending = new Map<string, Promise<boolean>>();

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
 * FAILS SILENT, like every other optional path in the proxy. A capture
 * directory that cannot be created, a disk that is full, a permissions error --
 * none of them is a reason to fail the request the user is waiting on. The
 * measurement is an optimisation on top of a working proxy.
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
  const line = `${JSON.stringify({ at: Date.now(), path, body: body.toString('utf8') })}\n`;
  const write = (pending.get(destination) ?? Promise.resolve(true)).then(
    async () => {
      try {
        await mkdir(destination, { recursive: true });
        await appendFile(join(destination, 'requests.jsonl'), line, 'utf8');
        return true;
      } catch {
        return false;
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
