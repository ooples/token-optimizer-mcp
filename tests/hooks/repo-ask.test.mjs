import { afterAll, describe, expect, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answer } from '../../hooks-core/ask.mjs';
import { quietEnvScript } from '../../hooks-core/quiet-env.mjs';
import { subagentBriefing } from '../../hooks-core/policy.mjs';

const repo = mkdtempSync(join(tmpdir(), 'ask-'));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const inRepo = (fn) => {
  const cwd = process.cwd();
  process.chdir(repo);
  try {
    return fn();
  } finally {
    process.chdir(cwd);
  }
};

describe('repo_ask', () => {
  test('answers where a name is defined and what calls it, with file:line', () => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'tools.ts'), 'export const DEFAULT_KEEP = 5;\nexport function keepTools(n: number) {\n  return n;\n}\n');
    writeFileSync(join(repo, 'src', 'server.ts'), "import { keepTools } from './tools';\nconst kept = keepTools(DEFAULT_KEEP);\n");
    inRepo(() => {
      expect(answer('where is DEFAULT_KEEP defined')).toContain('src/tools.ts:1:export const DEFAULT_KEEP = 5;');
      const calls = answer('what calls keepTools');
      expect(calls).toContain('src/server.ts:2:const kept = keepTools(DEFAULT_KEEP);');
      expect(calls).not.toContain('src/tools.ts:2');
    });
  });

  test('is opt-in: defined in every agent shell and named in the subagent briefing only when turned on', () => {
    expect(quietEnvScript({ TOKEN_OPTIMIZER_REPO_ASK: '1' }).script).toMatch(/^repo_ask\(\) \{ node '.+ask\.mjs' "\$@"; \}$/m);
    expect(quietEnvScript({}).script).not.toContain('repo_ask');
    expect(subagentBriefing({ agent_id: 'x' }, {})).not.toContain('repo_ask');
    process.env.TOKEN_OPTIMIZER_REPO_ASK = '1';
    try {
      expect(subagentBriefing({ agent_id: 'x' }, {})).toContain('repo_ask "<question>"');
    } finally {
      delete process.env.TOKEN_OPTIMIZER_REPO_ASK;
    }
  });
});
