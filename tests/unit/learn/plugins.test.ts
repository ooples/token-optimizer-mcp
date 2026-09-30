/**
 * Reading two agents' logs.
 *
 * Every transcript here is synthetic and every home directory is a temp directory:
 * the pass reads a user's own sessions, so a test of it must never touch the real
 * ones, and `TOKEN_OPTIMIZER_CLAUDE_HOME` / `TOKEN_OPTIMIZER_CODEX_HOME` exist for
 * exactly that. What is asserted is the part that decides whether the pass is worth
 * anything: a failure is recognised from what the format actually records, the
 * subject keeps the KIND of thing it is -- a command grouped as a path produces one
 * group per session and a rule from none -- and a file that cannot be read is
 * reported rather than skipped, because a pass over two of fifty files that says
 * nothing about the other forty-eight reports confidently on almost nothing.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const actual = await import('../../../src/learn/plugins/jsonl.js');
jest.unstable_mockModule('../../../src/learn/plugins/jsonl.js', () => ({
  ...actual,
  // Only a named path fails, so every other fixture is read for real. A read
  // failure is otherwise not reproducible on both platforms -- the mode bits that
  // would cause one on POSIX do not block a read on Windows.
  readJsonlHead: (path: string, maxBytes?: number) => {
    if (path.includes('poison')) throw new Error('EIO: simulated read failure');
    return actual.readJsonlHead(path, maxBytes);
  },
}));

const { claudePlugin } = await import('../../../src/learn/plugins/claude.js');
const { codexPlugin } = await import('../../../src/learn/plugins/codex.js');
const { FailureCategory, SubjectKind } = await import('../../../src/learn/models.js');

const CWD = 'C:/src/demo';

function lines(records: readonly unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

/** A Claude transcript: a successful call, then two failures. */
function claudeTranscript(): string {
  const use = (id: string, name: string, input: Record<string, unknown>) => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
  const reply = (id: string, text: string, isError: boolean) => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: [{ type: 'text', text }] }] },
  });
  return lines([
    { type: 'user', cwd: CWD, timestamp: '2026-09-01T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
    use('t1', 'Read', { file_path: 'C:/src/demo/gen/a.cs' }),
    reply('t1', '<tool_use_error>File does not exist.</tool_use_error>', true),
    use('t2', 'Bash', { command: 'cd C:/src/demo && gh pr view 7' }),
    reply('t2', 'Exit code 1\nfatal: not a git repository', true),
    use('t3', 'Read', { file_path: 'C:/src/demo/README.md' }),
    reply('t3', '# demo', false),
  ]);
}

/** A Codex rollout: one shell call that exited non-zero. */
function codexTranscript(cwd: string = CWD): string {
  return lines([
    { type: 'session_meta', payload: { type: 'session_meta', session_id: 'sess-1', cwd, timestamp: '2026-09-01T10:00:00.000Z' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'shell', input: { command: ['bash', '-lc', 'cargo fmt --check'], workdir: cwd } } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: { exit_code: 1, stdout: '', stderr: 'error: rustfmt is not installed' } } },
  ]);
}
describe('claudePlugin', () => {
  let home = '';
  let projectDir = '';
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'learn-claude-'));
    projectDir = join(home, '.claude', 'projects', 'C--src-demo');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'session-a.jsonl'), claudeTranscript(), 'utf8');
    process.env.TOKEN_OPTIMIZER_CLAUDE_HOME = home;
  });
  afterEach(() => {
    delete process.env.TOKEN_OPTIMIZER_CLAUDE_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('finds the project and the directory it ran in', () => {
    expect(claudePlugin.detect()).toBe(true);
    const [project] = claudePlugin.discoverProjects();
    expect(project?.name).toBe('C--src-demo');
    expect(project?.projectPath).toBe(CWD);
    expect(project?.sessionCount).toBe(1);
  });

  it('keeps only the failures, and counts every call it saw', () => {
    // The count of calls is the denominator of the failure rate, so a pass that
    // kept three failures out of three calls would read as a total catastrophe.
    const [project] = claudePlugin.discoverProjects();
    const [session] = claudePlugin.scanProject(project!);
    expect(session?.totalCalls).toBe(3);
    expect(session?.calls).toHaveLength(2);
    expect(session?.sessionId).toBe('session-a');
    expect(session?.startedAt?.toISOString()).toBe('2026-09-01T10:00:00.000Z');
  });

  it('records what each failure was about, and what kind of thing that is', () => {
    const [project] = claudePlugin.discoverProjects();
    const [session] = claudePlugin.scanProject(project!);
    const [read, shell] = session?.calls ?? [];
    expect(read?.name).toBe('Read');
    expect(read?.subject).toBe('C:/src/demo/gen/a.cs');
    expect(read?.subjectKind).toBe(SubjectKind.Path);
    expect(read?.category).toBe(FailureCategory.FileNotFound);
    expect(shell?.subject).toBe('cd C:/src/demo && gh pr view 7');
    expect(shell?.subjectKind).toBe(SubjectKind.Command);
    expect(shell?.detail).toBe('fatal: not a git repository');
  });

  it('says when it read only the head of a session', () => {
    const [project] = claudePlugin.discoverProjects();
    const [session] = claudePlugin.scanProject(project!, { maxBytesPerSession: 300 });
    expect(session?.truncated).toBe(true);
  });

  it('honours a session limit and a cutoff date', () => {
    writeFileSync(join(projectDir, 'session-b.jsonl'), claudeTranscript(), 'utf8');
    const [project] = claudePlugin.discoverProjects();
    expect(claudePlugin.scanProject(project!)).toHaveLength(2);
    expect(claudePlugin.scanProject(project!, { maxSessions: 1 })).toHaveLength(1);
    const tomorrow = new Date(Date.now() + 86_400_000);
    expect(claudePlugin.scanProject(project!, { since: tomorrow })).toHaveLength(0);
  });

  it('names a transcript it could not read instead of skipping it quietly', () => {
    writeFileSync(join(projectDir, 'poison.jsonl'), claudeTranscript(), 'utf8');
    const unreadable: string[] = [];
    const [project] = claudePlugin.discoverProjects();
    const sessions = claudePlugin.scanProject(project!, { onUnreadable: (path) => unreadable.push(path) });
    expect(sessions).toHaveLength(1);
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toContain('poison.jsonl');
  });

  it('writes to CLAUDE.md, which is the file this agent reads', () => {
    expect(claudePlugin.contextTarget().contextFile).toBe('CLAUDE.md');
  });
});
describe('codexPlugin', () => {
  let home = '';
  let dayDir = '';
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'learn-codex-'));
    dayDir = join(home, '.codex', 'sessions', '2026', '09', '01');
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(join(dayDir, 'rollout-2026-09-01T10-00-00-sess-1.jsonl'), codexTranscript(), 'utf8');
    process.env.TOKEN_OPTIMIZER_CODEX_HOME = home;
  });
  afterEach(() => {
    delete process.env.TOKEN_OPTIMIZER_CODEX_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('walks the date directories to find rollouts', () => {
    expect(codexPlugin.detect()).toBe(true);
    const [project] = codexPlugin.discoverProjects();
    expect(project?.projectPath).toBe(CWD);
    expect(project?.sessionCount).toBe(1);
  });

  it('reads the failure out of the reply the tool structured', () => {
    // Codex says how a call went in fields, not prose: a non-zero `exit_code` is
    // the failure, and reading the text alone would miss it entirely.
    const [project] = codexPlugin.discoverProjects();
    const [session] = codexPlugin.scanProject(project!);
    expect(session?.sessionId).toBe('sess-1');
    expect(session?.calls).toHaveLength(1);
    const [failure] = session?.calls ?? [];
    expect(failure?.name).toBe('shell');
    expect(failure?.detail).toContain('rustfmt is not installed');
  });

  it('joins an array command back into the line that was run', () => {
    // The input is a JSON document, not a field. Flattening the whole of
    // `{"command":["bash","-lc","..."]}` to text gave a subject that was mostly
    // punctuation, and a subject like that groups with nothing.
    const [project] = codexPlugin.discoverProjects();
    const [session] = codexPlugin.scanProject(project!);
    const [failure] = session?.calls ?? [];
    expect(failure?.subject).toBe('bash -lc cargo fmt --check');
    expect(failure?.subjectKind).toBe(SubjectKind.Command);
  });

  it('keeps a session that ran somewhere else out of this project', () => {
    // The project IS a working directory for this agent, so two projects share one
    // log tree and a scan that ignored cwd would mix them.
    writeFileSync(join(dayDir, 'rollout-elsewhere.jsonl'), codexTranscript('C:/src/other'), 'utf8');
    const projects = codexPlugin.discoverProjects();
    expect(projects).toHaveLength(2);
    const mine = projects.find((project) => project.projectPath === CWD);
    expect(codexPlugin.scanProject(mine!)).toHaveLength(1);
  });

  it('names a rollout it could not read', () => {
    writeFileSync(join(dayDir, 'rollout-poison.jsonl'), codexTranscript(), 'utf8');
    const unreadable: string[] = [];
    // A rollout whose head will not read has no recorded cwd either, so it belongs
    // to the project that stands for "somewhere unknown" -- which is where the loss
    // has to be reported, rather than dropped for having failed twice.
    const project = codexPlugin.discoverProjects().find((entry) => entry.projectPath === null);
    codexPlugin.scanProject(project!, { onUnreadable: (path) => unreadable.push(path) });
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toContain('poison');
  });

  it('writes to AGENTS.md and has no memory file', () => {
    expect(codexPlugin.contextTarget()).toEqual({ contextFile: 'AGENTS.md', memoryFile: null });
  });
});