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
import { clearSeen, loadState, saveState } from '../../src/hooks-core/policy.mjs';
import { promptSubmitted, toolCallObserved } from '../../src/hooks-core/task-session.mjs';
import { probeTaskSettings } from '../../src/hooks-core/doctor.mjs';

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
    expect(late.category).toBe(TaskCategory.BUILD);
    expect(late.calls).toBe(RECLASSIFY_WINDOW + 1);
    // Closed: neither a later call nor a later result counts or moves it.
    expect(afterToolCall(late, { tool_name: 'Read', tool_input: { file_path: bigLog } })).toBe(late);
    expect(afterToolCall(late, { tool_name: 'Read', tool_input: { file_path: bigLog } }, {}, { count: false })).toBe(late);
  });

  test("the last call's result is still judged; the next call's is not", () => {
    const red = (cmd) => ({
      tool_name: 'Bash',
      tool_input: { command: cmd },
      tool_response: { stdout: 'FAILED (failures=2)' },
    });
    let current = start(TaskCategory.UNKNOWN);
    for (let i = 0; i < RECLASSIFY_WINDOW - 1; i++)
      current = afterToolCall(current, { tool_name: 'Grep', tool_input: {} });
    // The sixth call: counted where it starts, judged on its result.
    const pre = afterToolCall(current, { tool_name: 'Bash', tool_input: { command: 'npm test' } });
    expect(pre.calls).toBe(RECLASSIFY_WINDOW);
    expect(afterToolCall(pre, red('npm test'), {}, { count: false }).category).toBe(TaskCategory.FIX);
    // A seventh call's red result comes after the window.
    const seventh = afterToolCall(pre, { tool_name: 'Bash', tool_input: { command: 'npm test' } });
    expect(afterToolCall(seventh, red('npm test'), {}, { count: false }).category).toBe(TaskCategory.UNKNOWN);
  });

  test('a judged-again result is not counted twice', () => {
    const once = afterToolCall(start(TaskCategory.BUILD), { tool_name: 'Grep', tool_input: {} });
    const again = afterToolCall(once, { tool_name: 'Grep', tool_input: {} }, {}, { count: false });
    expect(again.calls).toBe(1);
  });
});

describe('saved by parallel hooks (saveState)', () => {
  const PRIOR = process.env.TOKEN_OPTIMIZER_STATE_DIR;
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'task-merge-'));
    process.env.TOKEN_OPTIMIZER_STATE_DIR = dir;
  });
  afterAll(() => {
    if (PRIOR === undefined) delete process.env.TOKEN_OPTIMIZER_STATE_DIR;
    else process.env.TOKEN_OPTIMIZER_STATE_DIR = PRIOR;
    rmSync(dir, { recursive: true, force: true });
  });
  const grep = { tool_name: 'Grep', tool_input: {} };
  const red = {
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: { stdout: 'FAIL src/a.test.js' },
  };

  test('calls counted by hooks that loaded the same snapshot are added, not maxed', () => {
    const session = `m${Math.random().toString(36).slice(2)}`;
    promptSubmitted({ sessionId: session, prompt: 'fix the failing tests', cwd: dir, env: {} });
    const loaded = Array.from({ length: 4 }, () => loadState(session));
    for (const state of loaded) {
      toolCallObserved(state, grep, { cwd: dir });
      saveState(session, state);
    }
    expect(loadState(session).taskClass.calls).toBe(4);
  });

  test('one hook saving twice counts its call once', () => {
    // The router saves for a subagent briefing and again for its verdict.
    const session = `s${Math.random().toString(36).slice(2)}`;
    promptSubmitted({ sessionId: session, prompt: 'fix the failing tests', cwd: dir, env: {} });
    const state = loadState(session);
    toolCallObserved(state, grep, { cwd: dir });
    saveState(session, state);
    saveState(session, state);
    expect(loadState(session).taskClass.calls).toBe(1);
  });

  test('a tool hook with no prompt behind it counts from zero, in parallel too', () => {
    const session = `n${Math.random().toString(36).slice(2)}`;
    const loaded = Array.from({ length: 3 }, () => loadState(session));
    for (const state of loaded) {
      toolCallObserved(state, grep, { cwd: dir });
      saveState(session, state);
    }
    expect(loadState(session).taskClass).toMatchObject({ category: TaskCategory.UNKNOWN, calls: 3 });
  });

  test("a late correction from the previous prompt's task does not become the new task's", () => {
    const session = `g${Math.random().toString(36).slice(2)}`;
    promptSubmitted({ sessionId: session, prompt: 'Look around this repository.', cwd: dir, env: {}, now: 1000 });
    const stale = loadState(session); // a post-tool hook loads the first task
    expect(stale.taskClass.category).toBe(TaskCategory.UNKNOWN);
    promptSubmitted({ sessionId: session, prompt: 'Rewrite the whole file rules.py in TypeScript.', cwd: dir, env: {}, now: 2000 });
    toolCallObserved(stale, red, { cwd: dir, count: false }); // red tests: would settle UNKNOWN as FIX
    expect(stale.taskClass.category).toBe(TaskCategory.FIX);
    saveState(session, stale);
    expect(loadState(session).taskClass.category).toBe(TaskCategory.REWRITE);
  });

  test('a parallel correction cannot make a move one call could not', () => {
    // Both load UNKNOWN. One sees a rewrite and saves it; the other then sees
    // a red test -- FIX settles UNKNOWN, but never overrules a stored REWRITE.
    const session = `o${Math.random().toString(36).slice(2)}`;
    promptSubmitted({ sessionId: session, prompt: 'Look around this repository.', cwd: dir, env: {} });
    const rewriting = loadState(session);
    const testing = loadState(session);
    rewriting.seen = { [join(dir, 'a.js')]: 1 };
    toolCallObserved(rewriting, { tool_name: 'Write', tool_input: { file_path: join(dir, 'a.js') } }, { cwd: dir });
    expect(rewriting.taskClass.category).toBe(TaskCategory.REWRITE);
    saveState(session, rewriting);
    toolCallObserved(testing, red, { cwd: dir });
    expect(testing.taskClass.category).toBe(TaskCategory.FIX);
    saveState(session, testing);
    expect(loadState(session).taskClass).toMatchObject({ category: TaskCategory.REWRITE, calls: 2 });
  });

  test('a call that parallel saves push past the window moves nothing', () => {
    const session = `w${Math.random().toString(36).slice(2)}`;
    promptSubmitted({ sessionId: session, prompt: 'Rewrite the whole file rules.py in TypeScript.', cwd: dir, env: {} });
    const warm = loadState(session);
    for (let i = 0; i < RECLASSIFY_WINDOW - 1; i++) toolCallObserved(warm, grep, { cwd: dir });
    saveState(session, warm);
    // Two hooks load calls=5 at once: one is the sixth call, one the seventh.
    const sixth = loadState(session);
    const seventh = loadState(session);
    expect(sixth.taskClass.calls).toBe(RECLASSIFY_WINDOW - 1);
    toolCallObserved(sixth, grep, { cwd: dir });
    saveState(session, sixth);
    toolCallObserved(seventh, { tool_name: 'Read', tool_input: { file_path: bigLog } }, { cwd: dir });
    expect(seventh.taskClass.category).toBe(TaskCategory.LOCATE); // locally it looked inside
    saveState(session, seventh);
    expect(loadState(session).taskClass).toMatchObject({
      category: TaskCategory.REWRITE,
      calls: RECLASSIFY_WINDOW + 1,
    });
  });

  test('a compaction empties the read cache but keeps what was in view, through later saves', () => {
    const session = `k${Math.random().toString(36).slice(2)}`;
    const files = [join(dir, 'a.ts'), join(dir, 'b.ts')];
    const before = loadState(session);
    before.seen = Object.fromEntries(files.map((f) => [f, 1]));
    saveState(session, before);
    const stale = loadState(session); // a hook that loaded before the compaction
    expect(clearSeen(session, null, { anchors: true, now: 5_000 })).toBe(true);
    const after = loadState(session);
    expect(after.seen).toEqual({});
    expect(after.compactionAnchors).toEqual({ paths: files, at: 5_000 });
    saveState(session, stale); // ...saves afterwards
    expect(loadState(session).compactionAnchors).toEqual({ paths: files, at: 5_000 });
    // A plain clear (no compaction) leaves the anchors alone.
    clearSeen(session, null);
    expect(loadState(session).compactionAnchors).toEqual({ paths: files, at: 5_000 });
    // A later compaction with nothing in view still outranks the old set, even
    // when a hook that loaded the old set saves afterwards.
    const holdsOld = loadState(session);
    expect(clearSeen(session, null, { anchors: true, now: 9_000 })).toBe(true);
    saveState(session, holdsOld);
    expect(loadState(session).compactionAnchors).toEqual({ paths: [], at: 9_000 });
  });

  test("a tally never undoes a concurrent correction in the same task", () => {
    const session = `t${Math.random().toString(36).slice(2)}`;
    promptSubmitted({ sessionId: session, prompt: 'Look around this repository.', cwd: dir, env: {} });
    const correcting = loadState(session);
    const tallying = loadState(session);
    toolCallObserved(correcting, red, { cwd: dir });
    saveState(session, correcting);
    toolCallObserved(tallying, grep, { cwd: dir });
    saveState(session, tallying);
    expect(loadState(session).taskClass).toMatchObject({ category: TaskCategory.FIX, calls: 2 });
  });
});

describe('the doctor (probeTaskSettings)', () => {
  test('names the differing cells and the evidence behind them', () => {
    const [check] = probeTaskSettings({});
    expect(check.warn).toBeFalsy();
    expect(check.detail).toContain('survey.outputDiscipline=false');
    expect(check.detail).toContain('rewrite.outlineSubstitution=false');
  });

  test('an accepted switch is reported with the value it applies', () => {
    const [check] = probeTaskSettings({ TOKEN_OPTIMIZER_OUTLINE: 'off' });
    expect(check.warn).toBeFalsy();
    expect(check.detail).toContain('TOKEN_OPTIMIZER_OUTLINE=off turns outlineSubstitution off for every task');
  });

  test('a value the hooks ignore is a warning, never reported as applied', () => {
    const [check] = probeTaskSettings({ TOKEN_OPTIMIZER_OUTLINE: 'disabled' });
    expect(check.warn).toBe(true);
    expect(check.detail).toContain('ignored (not on/off): TOKEN_OPTIMIZER_OUTLINE=disabled');
    expect(check.detail).not.toContain('turns outlineSubstitution');
    // ...and the hooks agree it changes nothing.
    expect(settingsFor(TaskCategory.FIX, { TOKEN_OPTIMIZER_OUTLINE: 'disabled' }).outlineSubstitution).toBe(true);
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

  test('a survey writes without the block; every other category keeps it', () => {
    expect(settingsFor(TaskCategory.SURVEY, {}).outputDiscipline).toBe(false);
    for (const c of Object.values(TaskCategory).filter((c) => c !== TaskCategory.SURVEY))
      expect(settingsFor(c, {}).outputDiscipline).toBe(true);
  });

  test('an explicit switch wins over the table in both directions', () => {
    expect(settingsFor(TaskCategory.REWRITE, { TOKEN_OPTIMIZER_OUTLINE: 'on' }).outlineSubstitution).toBe(true);
    expect(settingsFor(TaskCategory.SURVEY, { TOKEN_OPTIMIZER_OUTPUT_DISCIPLINE: 'on' }).outputDiscipline).toBe(true);
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

  test('a survey prompt adds nothing; a later fix prompt then carries the block', () => {
    const session = `v${++seq}`;
    const prompt = (text) =>
      run('user-prompt-submit.mjs', {
        hook_event_name: 'UserPromptSubmit',
        cwd: workspace,
        session_id: session,
        prompt: text,
      });
    const survey = prompt('Perform a complete on-page SEO audit and write your findings to `seo_report.md`.');
    expect(survey.status).toBe(0);
    expect(survey.stdout.trim()).toBe('');
    expect(storedCategory(session)).toBe(TaskCategory.SURVEY);
    const fix = prompt('The project has failing tests. Find the root cause and fix the bug.');
    expect(JSON.parse(fix.stdout).hookSpecificOutput.additionalContext).toBe(OUTPUT_DISCIPLINE);
    expect(storedCategory(session)).toBe(TaskCategory.FIX);
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

  test('a paged read under a rewrite still ends outlining for the session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-paged-'));
    try {
      const first = join(dir, 'rules.py');
      const second = join(dir, 'more_rules.py');
      writeFileSync(first, rules());
      writeFileSync(second, rules().replaceAll('rule_', 'other_'));
      const session = `pg-${Math.random().toString(36).slice(2)}`;
      const prompt = (text) =>
        expect(hook('user-prompt-submit.mjs', session, { hook_event_name: 'UserPromptSubmit', prompt: text }, first).status).toBe(0);
      const read = (file, extra = {}) => {
        const result = hook('pretooluse-router.mjs', session, { tool_name: 'Read', tool_input: { file_path: file, ...extra } }, first);
        expect(result.status).toBe(0);
        return result.stdout.trim() ? (JSON.parse(result.stdout).hookSpecificOutput || {}).updatedInput?.file_path ?? null : null;
      };
      prompt('Fix the failing tests in rules.py.');
      expect(read(first)).toBeTruthy(); // outlined
      prompt('Rewrite the whole file rules.py in TypeScript.');
      read(first, { offset: 1, limit: 200 }); // the outline did not answer
      prompt('Fix the failing tests in more_rules.py.');
      expect(read(second)).toBeNull(); // so the session gets whole files from here on
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Copilot CLI: the block at SessionStart, the prompt hook only classifies', () => {
  // Its hooks reference says a config-file userPromptSubmitted hook's output is
  // dropped, so the block cannot depend on that hook (capabilities.mjs).
  test('SessionStart says the block; the prompt adds nothing and stores the category', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-copilot-'));
    try {
      const entries = join(HERE, '..', '..', 'src', 'integrations', 'copilot', '.github', 'hooks');
      const sessionId = `cp-${Math.random().toString(36).slice(2)}`;
      const hook = (script, payload) =>
        spawnSync(process.execPath, [join(entries, script)], {
          input: JSON.stringify({ sessionId, cwd: dir, ...payload }),
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
      const start = hook('session-start.mjs', { source: 'new' });
      expect(start.status).toBe(0);
      expect(start.stdout).toContain('Keep output lean');
      const prompt = hook('prompt.mjs', { prompt: 'The project has failing tests. Find the root cause and fix the bug.' });
      expect(prompt.status).toBe(0);
      expect(prompt.stdout.trim()).toBe('');
      const file = readdirSync(join(dir, 'state')).find((f) => f.startsWith(sessionId) && f.endsWith('.json'));
      expect(JSON.parse(readFileSync(join(dir, 'state', file), 'utf8')).taskClass.category).toBe(TaskCategory.FIX);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Cline: the prompt is read against its workspace', () => {
  test('a file named relative to workspaceRoots is sized there, not where the hook started', () => {
    const state = mkdtempSync(join(tmpdir(), 'task-cline-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'task-cline-cwd-'));
    try {
      const taskId = `cl-${Math.random().toString(36).slice(2)}`;
      const out = spawnSync(
        process.execPath,
        [join(HERE, '..', '..', 'src', 'integrations', 'cline', 'hooks', 'token-optimizer', 'prompt.mjs')],
        {
          // Cline's own shape: workspaceRoots, no cwd field.
          input: JSON.stringify({
            taskId,
            workspaceRoots: [workspace],
            userPromptSubmit: { prompt: 'Look at `release.log` and tell me about the deploy.' },
          }),
          cwd: elsewhere,
          encoding: 'utf8',
          timeout: 30_000,
          env: {
            ...process.env,
            TOKEN_OPTIMIZER_MODE: 'assist',
            TOKEN_OPTIMIZER_STATE_DIR: state,
            TOKEN_OPTIMIZER_WIKI_DIR: join(state, 'wiki'),
          },
        }
      );
      expect(out.status).toBe(0);
      const file = readdirSync(state).find((f) => f.startsWith(taskId) && f.endsWith('.json'));
      expect(JSON.parse(readFileSync(join(state, file), 'utf8')).taskClass.category).toBe(TaskCategory.LOCATE);
    } finally {
      rmSync(state, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('a compaction makes the block due again', () => {
  test('said, compacted, said again -- and not twice into one context', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-compact-'));
    try {
      const session = `c-${Math.random().toString(36).slice(2)}`;
      // As a real Claude Code payload does: the prompt hook scopes its state by
      // it, so SessionStart's marker must land in the same file.
      const transcript_path = join(dir, 'transcript.jsonl');
      const hook = (script, payload) =>
        spawnSync(process.execPath, [join(HOOKS, script)], {
          input: JSON.stringify({ session_id: session, cwd: dir, transcript_path, ...payload }),
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
