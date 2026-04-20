import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    gzipString,
    gunzipBuffer,
    saveGzippedFile,
    loadMaybeGzippedFile,
} from '../../src/utils/gzip.js';

describe('gzip utils', () => {
    const tempDirs: string[] = [];
    afterEach(() => {
        while (tempDirs.length) {
            const dir = tempDirs.pop();
            if (dir) {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });

    function tempDir(): string {
        const dir = mkdtempSync(join(tmpdir(), 'token-optimizer-gzip-'));
        tempDirs.push(dir);
        return dir;
    }

    it('gzipString round-trips via gunzipBuffer', () => {
        const text = 'Hello, world. '.repeat(1000);
        const buffer = gzipString(text);
        expect(buffer.length).toBeLessThan(text.length);
        expect(gunzipBuffer(buffer)).toBe(text);
    });

    it('saveGzippedFile writes .gz and removes plaintext', () => {
        const dir = tempDir();
        const file = join(dir, 'sessions.json');
        writeFileSync(file, 'stale plaintext');
        const stats = saveGzippedFile(file, JSON.stringify({ hello: 'world' }));
        expect(existsSync(`${file}.gz`)).toBe(true);
        expect(existsSync(file)).toBe(false);
        expect(stats.originalBytes).toBeGreaterThan(0);
        expect(stats.compressedBytes).toBeGreaterThan(0);
    });

    it('loadMaybeGzippedFile prefers the .gz sibling', () => {
        const dir = tempDir();
        const file = join(dir, 'state.json');
        saveGzippedFile(file, '{"compressed":true}');
        expect(loadMaybeGzippedFile(file)).toBe('{"compressed":true}');
    });

    it('loadMaybeGzippedFile falls back to plaintext when no .gz exists', () => {
        const dir = tempDir();
        const file = join(dir, 'legacy.json');
        writeFileSync(file, '{"legacy":true}');
        expect(loadMaybeGzippedFile(file)).toBe('{"legacy":true}');
    });

    it('loadMaybeGzippedFile returns null when neither exists', () => {
        const dir = tempDir();
        const file = join(dir, 'missing.json');
        expect(loadMaybeGzippedFile(file)).toBeNull();
    });

    it('saves with high compression ratio on repetitive content', () => {
        const dir = tempDir();
        const file = join(dir, 'repeated.txt');
        const stats = saveGzippedFile(file, 'aa'.repeat(10_000));
        expect(stats.percentSaved).toBeGreaterThan(95);
    });
});
