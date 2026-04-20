import { gzipSync, gunzipSync } from 'zlib';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'fs';
import { dirname } from 'path';

/**
 * Gzip utilities — addresses issue #126.
 *
 * `gzipString` / `gunzipBuffer` are thin UTF-8 wrappers around node:zlib.
 * `saveGzippedFile` writes `<path>.gz` atomically (tmp + rename) so a
 * crash mid-write can't produce a corrupt gzip. `loadFile` transparently
 * reads `<path>.gz` if present and falls back to the plaintext path —
 * that gives us backward compatibility with sessions.json files written
 * before this change.
 */

export interface GzipStats {
    originalBytes: number;
    compressedBytes: number;
    ratio: number;
    percentSaved: number;
}

export function gzipString(text: string, level: number = 6): Buffer {
    return gzipSync(Buffer.from(text, 'utf8'), { level });
}

export function gunzipBuffer(buffer: Buffer): string {
    return gunzipSync(buffer).toString('utf8');
}

export function computeStats(text: string, compressed: Buffer): GzipStats {
    const originalBytes = Buffer.byteLength(text, 'utf8');
    const compressedBytes = compressed.length;
    const ratio = originalBytes === 0 ? 0 : compressedBytes / originalBytes;
    return {
        originalBytes,
        compressedBytes,
        ratio,
        percentSaved: originalBytes === 0 ? 0 : (1 - ratio) * 100,
    };
}

/**
 * Write gzipped text to `${path}.gz` using atomic tmp + rename so a
 * crash mid-write never produces a half-written file. Also removes any
 * stale uncompressed plaintext at `path` once the gzip lands (backward
 * compat cleanup).
 */
export function saveGzippedFile(path: string, text: string, level: number = 6): GzipStats {
    const dir = dirname(path);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    const compressed = gzipString(text, level);
    const gzPath = `${path}.gz`;
    const tmpPath = `${gzPath}.tmp`;
    writeFileSync(tmpPath, compressed);
    renameSync(tmpPath, gzPath);
    if (existsSync(path)) {
        try {
            unlinkSync(path);
        } catch {
            // Best-effort — leaving the plaintext file isn't fatal.
        }
    }
    return computeStats(text, compressed);
}

/**
 * Load either `${path}.gz` or `${path}` — whichever exists. Returns
 * null if neither is present. If the `.gz` sibling exists but can't
 * be decompressed (corrupt, partially-written), falls back to the
 * plaintext path so the backward-compat migration still works.
 */
export function loadMaybeGzippedFile(path: string): string | null {
    const gzPath = `${path}.gz`;
    if (existsSync(gzPath)) {
        try {
            const buffer = readFileSync(gzPath);
            return gunzipBuffer(buffer);
        } catch (error) {
            if (!existsSync(path)) {
                throw error;
            }
            // Fall through to the plaintext sibling below.
        }
    }
    if (existsSync(path)) {
        return readFileSync(path, 'utf-8');
    }
    return null;
}
