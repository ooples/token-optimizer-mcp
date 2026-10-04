import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * `CacheEngine.set(key, value, originalSize, compressedSize, options?)`.
 *
 * The size slots are BYTE COUNTS. Before the fifth parameter existed there was
 * nowhere to put a TTL, so thirty-one call sites put theirs in a size slot --
 * `set(key, value, 86400, tokensSaved)` records 86400 as the entry's original
 * size, never expires, and poisons every ratio computed from those columns --
 * and thirty-seven more passed token counts, which are roughly a quarter of the
 * byte count they were standing in for.
 *
 * Nothing errors: every one of these is a number in a number's place. The
 * engine is not wrong, the call sites are, so that is what this checks. It is
 * the same shape of gate as cache-set-argument-order.test.ts, which catches the
 * orientation of the two sizes but not what they are.
 */

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Split an argument list at its top-level commas.
 *
 * A naive `.split(',')` cannot read these calls any more: the fifth argument is
 * an object literal, so `{ ttlSeconds: ttl || 60 }` would arrive as two
 * arguments and the call would be skipped as having the wrong arity -- which is
 * exactly the call this gate exists to inspect.
 */
function splitTopLevel(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;

  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(args.slice(start, i));
      start = i + 1;
    }
  }
  out.push(args.slice(start));
  return out.map((a) => a.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

export interface SizeSlotCall {
  file: string;
  line: number;
  original: string;
  compressed: string;
}

/** Every `cache.set(...)` call that passes the two size slots. */
function sizeSlotCalls(src: string, label: string): SizeSlotCall[] {
  const calls: SizeSlotCall[] = [];
  const re = /(?:^|[^\w.])(?:this\.)?cache\.set\(/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length;
    let depth = 1;
    let quote: string | null = null;
    let i = open;

    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (quote !== null) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
    }
    if (depth !== 0) continue;

    // Comments would otherwise be read as part of an argument: an `8 /* originalSize */`
    // reads as a size purely because of the words beside it.
    const args = splitTopLevel(
      src
        .slice(open, i - 1)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
    );
    if (args.length < 4) continue;

    calls.push({
      file: label,
      line: src.slice(0, open).split('\n').length,
      original: args[2],
      compressed: args[3],
    });
  }

  return calls;
}

/** Named like a duration, or one of the durations people write as a literal. */
const TTL_SHAPED =
  /(^|[^\w])(ttl|maxAge|cacheTTL|ttlSeconds|maxCacheAge|expiry|expires)/i;
const TTL_LITERAL = /^(60|120|300|600|900|1800|3600|7200|86400|604800)$/;
/** Tokens are not bytes: roughly a quarter of them, and never interchangeable. */
const TOKEN_SHAPED = /token/i;
/** What a byte count actually looks like in this codebase. */
const SIZE_SHAPED = /\.length\b|byteLength|\bsize\b/i;

function suspect(slot: string): string | null {
  if (SIZE_SHAPED.test(slot)) return null;
  if (TTL_LITERAL.test(slot)) return 'a bare duration';
  if (TTL_SHAPED.test(slot)) return 'a TTL';
  if (TOKEN_SHAPED.test(slot)) return 'a token count';
  return null;
}

function offences(calls: SizeSlotCall[]): string[] {
  const out: string[] = [];
  for (const c of calls) {
    for (const [name, slot] of [
      ['originalSize', c.original],
      ['compressedSize', c.compressed],
    ] as const) {
      const why = suspect(slot);
      if (why !== null) {
        out.push(`${c.file}:${c.line} ${name} is ${why}: "${slot}"`);
      }
    }
  }
  return out;
}

/**
 * Written to be caught. Without it a detector that silently matches nothing --
 * a changed call shape, a regex that stopped compiling the way it reads -- would
 * report a clean codebase, which is the one result this gate must never fake.
 */
const PLANTED = [
  "cache.set(key, value, 86400, tokensSaved);",
  "this.cache.set(k, v, 0, options.cacheTTL || 1800);",
  "cache.set(k, v, 8 /* originalSize */, ttl || 60);",
  "cache.set(k, v, tokensUsed, tokensUsed);",
].join('\n');

/** The honest idioms, which must NOT be flagged. */
const INNOCENT = [
  "cache.set(key, stored, stored.length, stored.length);",
  "cache.set(key, v, originalSize, compressedSize);",
  "cache.set(key, v, json.length, encoded.length, { ttlSeconds: ttl });",
  "this.cache.set(k, v, dataSize, dataSize, { ttlSeconds: maxAge });",
].join('\n');

describe('cache.set size slots hold sizes', () => {
  const calls = sourceFiles(SRC).flatMap((file) =>
    sizeSlotCalls(
      readFileSync(file, 'utf8'),
      file.replace(SRC, 'src').replace(/\\/g, '/')
    )
  );

  it('finds the call sites at all, so an empty pass cannot look like success', () => {
    expect(calls.length).toBeGreaterThan(50);
  });

  it('catches a TTL, a bare duration and a token count when they are there', () => {
    expect(offences(sizeSlotCalls(PLANTED, 'planted'))).toEqual([
      'planted:1 originalSize is a bare duration: "86400"',
      'planted:1 compressedSize is a token count: "tokensSaved"',
      'planted:2 compressedSize is a TTL: "options.cacheTTL || 1800"',
      'planted:3 compressedSize is a TTL: "ttl || 60"',
      'planted:4 originalSize is a token count: "tokensUsed"',
      'planted:4 compressedSize is a token count: "tokensUsed"',
    ]);
  });

  it('leaves the honest idioms alone', () => {
    const innocent = sizeSlotCalls(INNOCENT, 'innocent');
    expect(innocent).toHaveLength(4);
    expect(offences(innocent)).toEqual([]);
  });

  it('never puts a TTL or a token count in a size slot', () => {
    expect(offences(calls)).toEqual([]);
  });
});
