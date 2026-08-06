import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SmartAstGrepTool } from '../../../src/tools/code-analysis/smart-ast-grep.js';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';

/**
 * "Could not run" and "ran fine, found nothing" must be distinguishable.
 *
 * The tool spawned `npx.cmd`, which Node has refused since 20.12 (the fix for
 * CVE-2024-27980), so on Windows it failed with EINVAL on every call. The catch
 * logged to console.warn -- stderr, which an MCP client never sees -- and
 * returned an empty match array. A tool that could not run reported "0
 * matches".
 *
 * The first attempt at fixing that added an informative throw INSIDE the same
 * try, where the same catch swallowed it: a plain Error has no `.status`, so it
 * failed the exit-code-1 check and fell straight to the warn. The message was
 * written and then discarded. Review caught it; this pins the behaviour.
 */

describe('ast-grep distinguishes "no matches" from "could not run"', () => {
  let root: string;
  let cache: CacheEngine;
  let counter: TokenCounter;
  let tool: SmartAstGrepTool;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ast-grep-surfaces-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'a.ts'),
      'export function alpha() {\n  return 1;\n}\n'
    );

    cache = new CacheEngine(join(root, 'cache.db'), 100);
    counter = new TokenCounter();
    tool = new SmartAstGrepTool(cache, counter, new MetricsCollector());
  });

  afterEach(() => {
    cache.close();
    counter.free();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* temp dir, reclaimed by the OS */
    }
  });

  const grep = (pattern: string) =>
    tool.grep(pattern, {
      pattern,
      projectPath: root,
      language: 'ts',
      enableCache: false,
    });

  it('finds a function that is there', async () => {
    const result = await grep('function $NAME');

    // Before the spawn fix this was 0 on every Windows machine.
    expect(result.metadata.matchCount).toBeGreaterThan(0);
  }, 120_000);

  it('returns zero for a pattern that matches nothing, without throwing', async () => {
    // The empty answer must stay an ANSWER. Turning every empty result into an
    // error would be the opposite failure.
    const result = await grep('class $NOT_PRESENT_ANYWHERE');

    expect(result.metadata.matchCount).toBe(0);
  }, 120_000);

  it('throws when the CLI cannot be run at all', async () => {
    // Point the runtime at something unrunnable, which is what a missing or
    // unspawnable ast-grep looks like from inside.
    const notNode = join(root, 'not-a-runtime');
    writeFileSync(notNode, 'this is not an executable');

    const real = process.execPath;
    Object.defineProperty(process, 'execPath', {
      value: notNode,
      configurable: true,
    });

    try {
      await expect(grep('function $NAME')).rejects.toThrow(
        /ast-grep could not be run/
      );
    } finally {
      Object.defineProperty(process, 'execPath', {
        value: real,
        configurable: true,
      });
    }
  }, 120_000);

  it('names the package in the failure, so the message is actionable', async () => {
    const notNode = join(root, 'not-a-runtime-2');
    writeFileSync(notNode, 'this is not an executable');

    const real = process.execPath;
    Object.defineProperty(process, 'execPath', {
      value: notNode,
      configurable: true,
    });

    try {
      await expect(grep('function $NAME')).rejects.toThrow(/@ast-grep\/cli/);
    } finally {
      Object.defineProperty(process, 'execPath', {
        value: real,
        configurable: true,
      });
    }
  }, 120_000);
});
