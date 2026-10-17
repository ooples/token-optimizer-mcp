/**
 * Where the proxy spills a block, and what the marker calls it.
 *
 * The path is re-read on every turn its marker stays in context, so its shape
 * is a cost, not a detail: these pin the parts that keep it short and the
 * parts that keep it safe, and the one rule that keeps concurrent proxies from
 * deleting each other's live spills.
 */
import { describe, it, expect } from '@jest/globals';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  canonicalSpillPath,
  deadSpillRoots,
  processAlive,
  spillBase,
  spillName,
  spillRootFor,
} from '../../../src/compress/spill-path.js';

const salt = (seed: string): Buffer =>
  createHash('sha256').update(seed).digest();

describe('spillName', () => {
  it('is fifteen decimal digits, zero-padded', () => {
    for (let i = 0; i < 200; i++)
      expect(spillName(salt('a'), `block ${i}`)).toMatch(/^\d{15}$/);
  });

  it('is content-addressed: the same bytes under one salt get one name', () => {
    expect(spillName(salt('a'), 'same')).toBe(spillName(salt('a'), 'same'));
    expect(spillName(salt('a'), 'same')).not.toBe(
      spillName(salt('a'), 'other')
    );
  });

  it('depends on the salt, so a name is not predictable from the content', () => {
    expect(spillName(salt('a'), 'same')).not.toBe(spillName(salt('b'), 'same'));
  });
});

describe('spillRootFor', () => {
  it('names the first proxy in a process by its pid alone', () => {
    expect(spillRootFor('/h/.tok', 4242)).toBe(join('/h/.tok', '4242'));
  });

  it('gives every later proxy in the same process its own directory', () => {
    const roots = [0, 1, 2].map((n) => spillRootFor('/h/.tok', 4242, n));
    expect(new Set(roots).size).toBe(3);
    expect(roots[1]).toBe(join('/h/.tok', '4242-1'));
  });
});

describe('spillBase', () => {
  it('is .tok under the home directory', () => {
    expect(spillBase('/home/u', {})).toBe(join('/home/u', '.tok'));
  });

  it('honours TOKEN_OPTIMIZER_SPILL_ROOT, and ignores a blank one', () => {
    expect(spillBase('/home/u', { TOKEN_OPTIMIZER_SPILL_ROOT: '/x/y' })).toBe(
      '/x/y'
    );
    expect(spillBase('/home/u', { TOKEN_OPTIMIZER_SPILL_ROOT: '  ' })).toBe(
      join('/home/u', '.tok')
    );
  });
});

describe('deadSpillRoots', () => {
  const alive = (pids: number[]) => (pid: number) => pids.includes(pid);

  it('returns the directories of proxies the OS says are gone', () => {
    expect(
      deadSpillRoots(['100', '200', '200-3', '300'], 1, alive([200]))
    ).toEqual(['100', '300']);
  });

  it('never returns its own directories, even if asked about a dead self', () => {
    expect(deadSpillRoots(['7', '7-1'], 7, alive([]))).toEqual([]);
  });

  it('leaves alone anything that is not a proxy directory', () => {
    expect(
      deadSpillRoots(
        ['notes', '0', '012', '12-', '12-0', '12-a', '1.5', ''],
        1,
        alive([])
      )
    ).toEqual([]);
  });
});

describe('processAlive', () => {
  it('sees this process', () => {
    expect(processAlive(process.pid)).toBe(true);
  });

  it('does not see a pid no process can have', () => {
    expect(processAlive(2 ** 31 - 1)).toBe(false);
  });
});

describe('canonicalSpillPath', () => {
  it('has the shape of a real one: absolute, under .tok, a pid, then the name', () => {
    expect(canonicalSpillPath('000000000000000')).toBe(
      '/home/user/.tok/4194303/000000000000000'
    );
  });
});
