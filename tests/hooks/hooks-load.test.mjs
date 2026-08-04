/**
 * Every hook entry point must actually load.
 *
 * A guard for the cheapest possible failure, added because it happened: an edit
 * inserted a block into the MIDDLE of a `record(dir, {...})` call in
 * harvest-worker.mjs, severing it. The file was not merely wrong, it was a
 * SYNTAX ERROR -- it could not be parsed at all, so the detached harvest worker
 * had been dead on arrival and the entire feedback pipeline with it.
 *
 * The full suite stayed green. Every test exercised the shared core through
 * `hooks-core/`, and nothing imported the hook scripts themselves, so a file
 * that could not be parsed was simply never parsed. Reported by CodeRabbit as a
 * missing `wikiDir` import, which was the second defect in the same file and the
 * one visible from a diff.
 *
 * `node --check` is not enough on its own: it validates syntax but not that the
 * imports resolve, and a missing import is exactly the other half of what went
 * wrong here. So each entry point is really imported, in a child process, with
 * the environment set so it exits without doing any work.
 */
import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'child_process';
import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { ESLint } from 'eslint';

const HOOK_DIRS = [
  'plugin/hooks',
  'integrations/codex/hooks',
  'integrations/codex/plugin/hooks',
  'integrations/gemini/hooks',
  'integrations/qwen/hooks',
  'integrations/opencode/hooks',
];

function entryPoints() {
  const out = [];
  for (const dir of HOOK_DIRS) {
    const full = join(process.cwd(), dir);
    if (!existsSync(full)) continue;
    for (const name of readdirSync(full)) {
      // `lib/` is the vendored core and is covered by the suites that use it.
      if (name.endsWith('.mjs')) out.push(join(dir, name));
    }
  }
  return out;
}

const ENTRIES = entryPoints();

describe('hook entry points', () => {
  it('finds some to check, so an empty list cannot pass vacuously', () => {
    expect(ENTRIES.length).toBeGreaterThan(5);
  });

  it.each(ENTRIES)('%s parses and its imports resolve', (rel) => {
    // TOKEN_OPTIMIZER_MODE=off makes every entry point exit at its first line,
    // so this measures loadability and nothing else -- no graph is touched and
    // no work is done.
    const r = spawnSync(process.execPath, [join(process.cwd(), rel)], {
      input: '{}',
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, TOKEN_OPTIMIZER_MODE: 'off' },
    });

    const stderr = String(r.stderr || '');
    expect(stderr).not.toMatch(/SyntaxError/);
    expect(stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(stderr).not.toMatch(/ReferenceError/);
    expect(stderr).not.toMatch(/is not defined/);
    // Fail open is the contract: a hook must never break the turn it runs in.
    expect(r.status).toBe(0);
  }, 60_000);
});

describe('no hook entry point references an undefined name', () => {
  // RUNNING THE HOOK IS NOT ENOUGH, which I established by trying it. Removing
  // the `wikiDir` import from harvest-worker.mjs leaves the loadability test
  // above completely green: `main()` returns early when it is handed no
  // transcript, so the line that would throw is never reached. The same shape
  // hid a missing `join` import in precompact-optimize.mjs, where the only
  // caller sat behind a CLAUDE_PLUGIN_ROOT check.
  //
  // A fail-open hook is precisely the kind of program whose body does not run
  // in a smoke test, so this is checked statically instead. `npm run lint`
  // covers `src` only, which is why nothing was watching these files.
  it('passes no-undef across every hook directory', async () => {
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: {
        languageOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
          globals: {
            process: 'readonly', console: 'readonly', URL: 'readonly',
            Buffer: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
            setInterval: 'readonly', clearInterval: 'readonly',
            TextEncoder: 'readonly', TextDecoder: 'readonly', fetch: 'readonly',
            AbortController: 'readonly', SharedArrayBuffer: 'readonly',
            Int32Array: 'readonly', Atomics: 'readonly', structuredClone: 'readonly',
          },
        },
        rules: { 'no-undef': 'error' },
      },
    });

    const results = await eslint.lintFiles(HOOK_DIRS.map((d) => `${d}/*.mjs`));
    const problems = results.flatMap((r) =>
      r.messages.map((m) => `${r.filePath}:${m.line} ${m.message}`)
    );

    // A glob that matched nothing would report zero problems and pass.
    expect(results.length).toBeGreaterThan(5);
    expect(problems).toEqual([]);
  }, 120_000);
});
