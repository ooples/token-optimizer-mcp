/**
 * Task categories and the settings that follow them (task-class.mjs,
 * task-settings.mjs, task-session.mjs), through the shipped hook entries.
 */
import { describe, expect, test, beforeAll, afterAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TaskCategory,
  afterToolCall,
  classifyPrompt,
  RECLASSIFY_WINDOW,
} from '../../src/hooks-core/task-class.mjs';
import {
  EVIDENCE,
  OUTPUT_DISCIPLINE,
  settingsFor,
  settingsTable,
} from '../../src/hooks-core/task-settings.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(HERE, '..', '..', 'src', 'plugin', 'hooks');

let workspace;
let stateDir;
let bigLog;
beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'task-class-'));
  stateDir = mkdtempSync(join(tmpdir(), 'task-class-state-'));
  bigLog = join(workspace, 'release.log');
  writeFileSync(bigLog, 'line\n'.repeat(80_000)); // 400 KB
});
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe('the prompt pass', () => {
  // Paraphrases of the THOL task prompts, one per category, plus the shapes
  // the categories exist for. The full prompts are in te-bench, not here.
  test.each([
    ['The project has failing tests. Run the suite, find the root cause and fix the bug.', TaskCategory.FIX],
    ['The `ledger` package has a FAILING test suite. Find and fix every bug.', TaskCategory.FIX],
    ['Implement the feature described in `SPEC.md`. The existing tests must keep passing.', TaskCategory.BUILD],
    ['Perform the migration described in `MIGRATION.md`, completely.', TaskCategory.BUILD],
    ['Perform the refactor in `REFACTOR.md`: split `shapes.py` into a package.', TaskCategory.BUILD],
    ['Perform a complete on-page SEO audit and write your findings to `seo_report.md`.', TaskCategory.SURVEY],
    ['Write a file `ARCHITECTURE.md` at the repository root for a new contributor.', TaskCategory.SURVEY],
    ['Rewrite the whole file `legacy.js` in TypeScript.', TaskCategory.REWRITE],
    ['Why does the cache miss on the second call?', TaskCategory.EXPLAIN],
    ['当前目录中的日志很长，找出导致发布失败的那一行。', TaskCategory.LOCATE],
  ])('%s -> %s', (prompt, expected) => {
    expect(classifyPrompt(prompt).category).toBe(expected);
  });

  test('weak or tied evidence is UNKNOWN, whose row is today\'s product', () => {
    expect(classifyPrompt('hello').category).toBe(TaskCategory.UNKNOWN);
    expect(classifyPrompt('').category).toBe(TaskCategory.UNKNOWN);
    expect(settingsFor(TaskCategory.UNKNOWN, {})).toEqual({
      outputDiscipline: true,
      outlineSubstitution: true,
    });
  });

  test('a large file the prompt names makes it a search, read by size only', () => {
    const named = classifyPrompt('Look at `release.log` and tell me about the deploy.', { cwd: workspace });
    expect(named.category).toBe(TaskCategory.LOCATE);
    expect(named.signals.some((s) => s.startsWith('locate:large-input:'))).toBe(true);
  });

  test('only the head of a prompt is read: a pasted log cannot decide it', () => {
    const pasted = `Implement the feature in SPEC.md.\n${'x'.repeat(5000)} find the failing line in this log`;
    expect(classifyPrompt(pasted).category).toBe(TaskCategory.BUILD);
  });
});

describe('the tool-call pass', () => {
  const start = (category) => ({ category, source: 'prompt', calls: 0, at: 1 });

  test('a whole-file read of a huge input overrules the prompt', () => {
    const next = afterToolCall(start(TaskCategory.BUILD), {
      tool_name: 'Read',
      tool_input: { file_path: bigLog },
    });
    expect(next).toMatchObject({ category: TaskCategory.LOCATE, source: 'tools', calls: 1 });
  });

  test('a paged read of the same file is not evidence', () => {
    const next = afterToolCall(start(TaskCategory.BUILD), {
      tool_name: 'Read',
      tool_input: { file_path: bigLog, offset: 0, limit: 50 },
    });
    expect(next.category).toBe(TaskCategory.BUILD);
  });

  test('writing over a file the session read is a rewrite', () => {
    const call = { tool_name: 'Write', tool_input: { file_path: '/w/a.js' } };
    expect(afterToolCall(start(TaskCategory.BUILD), call, { readPaths: ['/w/a.js'] }).category).toBe(
      TaskCategory.REWRITE
    );
    expect(afterToolCall(start(TaskCategory.BUILD), call, { readPaths: [] }).category).toBe(
      TaskCategory.BUILD
    );
  });

  test('a red test run settles UNKNOWN but never overrules BUILD', () => {
    const red = {
      tool_name: 'Bash',
      tool_input: { command: 'python3 -m unittest discover -s tests' },
      tool_response: { stdout: 'FAILED (failures=2)' },
    };
    expect(afterToolCall(start(TaskCategory.UNKNOWN), red).category).toBe(TaskCategory.FIX);
    expect(afterToolCall(start(TaskCategory.BUILD), red).category).toBe(TaskCategory.BUILD);
  });

  test('the window closes: evidence after it moves nothing', () => {
    let current = start(TaskCategory.BUILD);
    for (let i = 0; i < RECLASSIFY_WINDOW; i++)
      current = afterToolCall(current, { tool_name: 'Grep', tool_input: {} });
    expect(current.calls).toBe(RECLASSIFY_WINDOW);
    const late = afterToolCall(current, { tool_name: 'Read', tool_input: { file_path: bigLog } });
    expect(late).toBe(current);
  });

  test('a judged-again result is not counted twice', () => {
    const once = afterToolCall(start(TaskCategory.BUILD), { tool_name: 'Grep', tool_input: {} });
    const again = afterToolCall(once, { tool_name: 'Grep', tool_input: {} }, {}, { count: false });
    expect(again.calls).toBe(1);
  });
});

describe('the settings table', () => {
  test('every cell that differs from UNKNOWN names its evidence', () => {
    const table = settingsTable();
    const base = table[TaskCategory.UNKNOWN];
    for (const [category, row] of Object.entries(table))
      for (const [setting, value] of Object.entries(row))
        if (value !== base[setting]) expect(EVIDENCE[`${category}.${setting}`]).toMatch(/\S{20,}/);
  });

  test('a rewrite gets no outline; every other category keeps it', () => {
    expect(settingsFor(TaskCategory.REWRITE, {}).outlineSubstitution).toBe(false);
    for (const c of Object.values(TaskCategory).filter((c) => c !== TaskCategory.REWRITE))
      expect(settingsFor(c, {}).outlineSubstitution).toBe(true);
  });

  test('an explicit switch wins over the table in both directions', () => {
    expect(settingsFor(TaskCategory.REWRITE, { TOKEN_OPTIMIZER_OUTLINE: 'on' }).outlineSubstitution).toBe(true);
    expect(settingsFor(TaskCategory.FIX, { TOKEN_OPTIMIZER_OUTPUT_DISCIPLINE: 'off' }).outputDiscipline).toBe(false);
    expect(settingsFor(TaskCategory.FIX, { TOKEN_OPTIMIZER_OUTPUT_DISCIPLINE: 'maybe' }).outputDiscipline).toBe(true);
  });

  test('a category that is not in the closed set is UNKNOWN', () => {
    expect(settingsFor('rewite', {})).toEqual(settingsFor(TaskCategory.UNKNOWN, {}));
  });
});

describe('through the Claude Code hooks', () => {
  let seq = 0;
  const env = (extra = {}) => ({
    ...process.env,
    TOKEN_OPTIMIZER_MODE: 'assist',
    TOKEN_OPTIMIZER_STATE_DIR: stateDir,
    TOKEN_OPTIMIZER_WIKI_DIR: stateDir,
    TOKEN_OPTIMIZER_SHARED_DIR: stateDir,
    TOKEN_OPTIMIZER_OUTPUT_DISCIPLINE: '',
    TOKEN_OPTIMIZER_OUTLINE: '',
    ...extra,
  });
  const run = (script, payload, extra) =>
    spawnSync(process.execPath, [join(HOOKS, script)], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 30_000,
      env: env(extra),
    });
  const storedCategory = (session) => {
    const file = readdirSync(stateDir).find((f) => f.includes(session) && f.endsWith('.json'));
    return file ? JSON.parse(readFileSync(join(stateDir, file), 'utf8')).taskClass?.category : undefined;
  };

  test('SessionStart leaves the block to the prompt', () => {
    const out = run('session-start.mjs', { hook_event_name: 'SessionStart', cwd: workspace, session_id: `s${++seq}` }).stdout;
    expect(out).toContain('Token optimization is active');
    expect(out).not.toContain('Keep output lean');
  });

  test('the first prompt carries the block once, and the category is stored', () => {
    const session = `p${++seq}`;
    const prompt = (text) =>
      run('user-prompt-submit.mjs', {
        hook_event_name: 'UserPromptSubmit',
        cwd: workspace,
        session_id: session,
        prompt: text,
      });
    const first = prompt('The project has failing tests. Find the root cause and fix the bug.');
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout).hookSpecificOutput).toEqual({
      hookEventName: 'UserPromptSubmit',
      additionalContext: OUTPUT_DISCIPLINE,
    });
    expect(storedCategory(session)).toBe(TaskCategory.FIX);
    const second = prompt('Now write `NOTES.md` summarising the audit.');
    expect(second.stdout.trim()).toBe('');
    expect(storedCategory(session)).toBe(TaskCategory.SURVEY);
  });

  test('switched off, the prompt adds nothing', () => {
    const out = run(
      'user-prompt-submit.mjs',
      { hook_event_name: 'UserPromptSubmit', cwd: workspace, session_id: `o${++seq}`, prompt: 'fix the failing tests' },
      { TOKEN_OPTIMIZER_OUTPUT_DISCIPLINE: '0' }
    );
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });
});

describe('a rewrite session reads the real file (rewrite.outlineSubstitution)', () => {
  const PRIOR_HOLDOUT = process.env.TOKEN_OPTIMIZER_HOLDOUT;
  beforeAll(() => {
    // Pinned to the delivered arm, as outline-substitution.test.mjs explains.
    process.env.TOKEN_OPTIMIZER_HOLDOUT = '0';
  });
  afterAll(() => {
    if (PRIOR_HOLDOUT === undefined) delete process.env.TOKEN_OPTIMIZER_HOLDOUT;
    else process.env.TOKEN_OPTIMIZER_HOLDOUT = PRIOR_HOLDOUT;
  });

  const rules = () => {
    const out = [];
    for (let i = 0; i < 300; i++)
      out.push(
        `def rule_${String(i).padStart(4, '0')}(amount, rate):`,
        '    """Applies a pricing rule and rounds the result."""',
        '    if amount < 0:',
        '        raise ValueError("amount must not be negative")',
        '    return round(amount * rate)',
        ''
      ); // ~58 KB: outlined, where a ~26 KB file is refused instead
    return out.join('\n');
  };

  const hook = (script, session, payload, file) =>
    spawnSync(process.execPath, [join(HOOKS, script)], {
      input: JSON.stringify({ session_id: session, cwd: dirname(file), ...payload }),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        TOKEN_OPTIMIZER_MODE: 'enforce',
        TOKEN_OPTIMIZER_MCP_CAPABILITIES: 'smart_read,smart_write,smart_edit,smart_glob,smart_grep',
        TOKEN_OPTIMIZER_STATE_DIR: join(dirname(file), 'state'),
        TOKEN_OPTIMIZER_WIKI_DIR: join(dirname(file), 'wiki'),
        TOKEN_OPTIMIZER_OUTLINE: '',
      },
    });

  const readAfter = (prompt) => {
    const dir = mkdtempSync(join(tmpdir(), 'task-rewrite-'));
    try {
      const file = join(dir, 'rules.py');
      writeFileSync(file, rules());
      const session = `rw-${Math.random().toString(36).slice(2)}`;
      expect(hook('user-prompt-submit.mjs', session, { hook_event_name: 'UserPromptSubmit', prompt }, file).status).toBe(0);
      const result = hook('pretooluse-router.mjs', session, { tool_name: 'Read', tool_input: { file_path: file } }, file);
      expect(result.status).toBe(0);
      const out = result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput || {} : {};
      return out.updatedInput?.file_path ?? null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('an ordinary session is outlined; a rewrite session is not', () => {
    // The control proves the file is outline-sized, so the absence below is the setting.
    expect(readAfter('Fix the failing tests in rules.py.')).toBeTruthy();
    expect(readAfter('Rewrite the whole file rules.py in TypeScript.')).toBeNull();
  });
});

describe('a compaction makes the block due again', () => {
  test('said, compacted, said again -- and not twice into one context', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-compact-'));
    try {
      const session = `c-${Math.random().toString(36).slice(2)}`;
      const hook = (script, payload) =>
        spawnSync(process.execPath, [join(HOOKS, script)], {
          input: JSON.stringify({ session_id: session, cwd: dir, ...payload }),
          encoding: 'utf8',
          timeout: 30_000,
          env: {
            ...process.env,
            TOKEN_OPTIMIZER_MODE: 'assist',
            TOKEN_OPTIMIZER_STATE_DIR: join(dir, 'state'),
            TOKEN_OPTIMIZER_WIKI_DIR: join(dir, 'wiki'),
            TOKEN_OPTIMIZER_OUTPUT_DISCIPLINE: '',
          },
        });
      const prompt = () =>
        hook('user-prompt-submit.mjs', { hook_event_name: 'UserPromptSubmit', prompt: 'fix the failing tests' }).stdout;
      hook('session-start.mjs', { hook_event_name: 'SessionStart', source: 'startup' });
      expect(prompt()).toContain('Keep output lean');
      expect(prompt().trim()).toBe('');
      hook('session-start.mjs', { hook_event_name: 'SessionStart', source: 'compact' });
      expect(prompt()).toContain('Keep output lean');
      expect(prompt().trim()).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
