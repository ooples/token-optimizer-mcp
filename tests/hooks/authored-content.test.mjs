/**
 * The authored-content store: "THIS session wrote these bytes".
 *
 * WHY IT IS NOT THE WIKI SNAPSHOT. `indexFile` runs on every file either hook
 * OBSERVES, reads included, so a graph snapshot answers "what did some hook last
 * see" -- across sessions. Using it as a diff base would hand a fresh session
 * `// No changes` for a file it has never seen, which is worse than resending
 * the file: it withholds content while reporting success.
 *
 * This store answers a different question. A record is written only by a WRITE,
 * and carries the session that made it, so a reader can ask "did I write this?"
 * rather than "has anyone seen this?".
 *
 * DEGRADATION IS ONE-DIRECTIONAL BY CONSTRUCTION. No record, unreadable record,
 * different session, or content whose hash no longer matches all mean *no base*
 * -- and no base means the caller resends the file, which is exactly today's
 * behaviour. The store can therefore never make a read worse than it is now.
 */

import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  recordAuthoredContent,
  authoredContentFor,
} from '../../hooks-core/authored.mjs';

let dir;
const CONTENT = 'export const a = 1;\n'.repeat(20);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'authored-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = () => join(dir, 'src.ts');

describe('a session reads back what it wrote', () => {
  test('returns the content it recorded', () => {
    writeFileSync(file(), CONTENT);
    recordAuthoredContent(dir, 's-1', file(), CONTENT);
    expect(authoredContentFor(dir, 's-1', file())).toBe(CONTENT);
  });
});

describe('cross-session isolation -- the failure that disqualified the snapshot', () => {
  test('a DIFFERENT session gets no base', () => {
    writeFileSync(file(), CONTENT);
    recordAuthoredContent(dir, 'session-a', file(), CONTENT);

    // Session B has never seen this file. Handing it a base would make
    // smart_read answer "no changes" and deliver nothing.
    expect(authoredContentFor(dir, 'session-b', file())).toBeNull();
  });

  test('an absent session id gets no base', () => {
    writeFileSync(file(), CONTENT);
    recordAuthoredContent(dir, 'session-a', file(), CONTENT);
    expect(authoredContentFor(dir, null, file())).toBeNull();
    expect(authoredContentFor(dir, '', file())).toBeNull();
  });
});

describe('the record must still describe the file on disk', () => {
  test('content changed since the write means no base', () => {
    // Another process edited the file after we wrote it. The recorded bytes are
    // no longer a truthful "before", so the read must not diff against them.
    writeFileSync(file(), CONTENT);
    recordAuthoredContent(dir, 's-1', file(), CONTENT);
    writeFileSync(file(), CONTENT + '// appended\n');
    expect(authoredContentFor(dir, 's-1', file())).toBeNull();
  });

  test('a deleted file means no base rather than a throw', () => {
    writeFileSync(file(), CONTENT);
    recordAuthoredContent(dir, 's-1', file(), CONTENT);
    rmSync(file());
    expect(authoredContentFor(dir, 's-1', file())).toBeNull();
  });
});

describe('it never throws, because a hook must not break a tool call', () => {
  test('an unwritable store is a miss, not an error', () => {
    expect(() =>
      recordAuthoredContent('\0bad', 's-1', file(), CONTENT)
    ).not.toThrow();
    expect(authoredContentFor('\0bad', 's-1', file())).toBeNull();
  });

  test('reading a store that was never written is a miss', () => {
    expect(authoredContentFor(dir, 's-1', file())).toBeNull();
  });

  test('a corrupt record is a miss, not a crash', () => {
    writeFileSync(file(), CONTENT);
    recordAuthoredContent(dir, 's-1', file(), CONTENT);
    const store = join(dir, '.token-optimizer', 'authored');
    for (const name of readdirSync(store)) {
      writeFileSync(join(store, name), '{not json');
    }
    expect(authoredContentFor(dir, 's-1', file())).toBeNull();
  });
});

describe('bounded, so the store cannot mirror the repository', () => {
  test('content past the cap is not recorded', () => {
    const huge = 'x'.repeat(400_000);
    writeFileSync(file(), huge);
    recordAuthoredContent(dir, 's-1', file(), huge);
    expect(authoredContentFor(dir, 's-1', file())).toBeNull();
  });
});

describe('the cap counts persisted bytes, not UTF-16 units', () => {
  test('multibyte content over the byte cap is rejected', () => {
    // 100k CJK characters measure 100,000 by `content.length` -- under a
    // 262,144 cap -- while persisting 300,000 UTF-8 bytes. Counting units let
    // a record 15% over the limit through.
    const multibyte = '日'.repeat(100_000);
    expect(multibyte.length).toBeLessThan(262_144);
    expect(Buffer.byteLength(multibyte, 'utf8')).toBeGreaterThan(262_144);

    writeFileSync(file(), multibyte);
    recordAuthoredContent(dir, 's-1', file(), multibyte);
    expect(authoredContentFor(dir, 's-1', file())).toBeNull();
  });

  test('multibyte content under the byte cap is still recorded', () => {
    // Guards against over-correction: the byte check must not reject content
    // that genuinely fits.
    const ok = '日'.repeat(1000);
    writeFileSync(file(), ok);
    recordAuthoredContent(dir, 's-1', file(), ok);
    expect(authoredContentFor(dir, 's-1', file())).toBe(ok);
  });
});
