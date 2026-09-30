/**
 * Turning failures into rules.
 *
 * The grouping is the whole value of the pass: a hundred failures that group onto
 * `cd` are one worthless rule standing where a dozen real ones were, and a subject
 * that groups by nothing produces sixteen groups of one, from which no rule can ever
 * be written. So the cases below are the ones a real corpus broke -- a wrapped
 * command, a chained line whose failing statement is not recorded anywhere, a shell
 * failure whose subject is a command and not the directory it was typed in -- plus
 * the two refusals that keep the output worth reading: a rule is not written from
 * work failing, and a rule is not written from evidence that says nothing.
 */
import { describe, it, expect } from '@jest/globals';
import {
  Confidence,
  FailureCategory,
  SubjectKind,
  type ProjectInfo,
  type SessionData,
  type ToolCall,
} from '../../../src/learn/models.js';
import { CHAINED, MIN_OCCURRENCES, analyse, groupKey } from '../../../src/learn/analyze.js';

const PROJECT: ProjectInfo = {
  name: 'demo',
  projectPath: 'C:/src/demo',
  dataPath: 'C:/logs/demo',
  sessionCount: 1,
};

interface CallPatch {
  readonly name?: string;
  readonly subject?: string;
  readonly subjectKind?: SubjectKind;
  readonly category?: FailureCategory;
  readonly detail?: string;
  readonly outputBytes?: number;
}

function call(patch: CallPatch = {}): ToolCall {
  return {
    name: patch.name ?? 'Bash',
    id: 'call-1',
    subject: patch.subject ?? '',
    subjectKind: patch.subjectKind ?? SubjectKind.None,
    failed: true,
    category: patch.category ?? FailureCategory.ExitCode,
    detail: patch.detail ?? 'fatal: not a git repository',
    outputBytes: patch.outputBytes ?? 100,
    index: 0,
  };
}

/** One session holding `count` copies of the same failure, as a habit looks. */
function habit(count: number, patch: CallPatch = {}, sessionId = 's1'): SessionData {
  const calls: ToolCall[] = [];
  for (let index = 0; index < count; index += 1) calls.push({ ...call(patch), index });
  return { sessionId, agent: 'claude', calls, totalCalls: count, startedAt: null, truncated: false };
}

const shell = (command: string): ToolCall =>
  call({ subject: command, subjectKind: SubjectKind.Command });
describe('groupKey', () => {
  it('names the program a wrapped command line actually ran', () => {
    // THE DEFECT THIS RULES OUT. Almost every command an agent runs begins
    // `cd <somewhere> &&`, so reading the first word grouped 107 real failures in one
    // corpus onto `cd` -- one useless rule standing exactly where a dozen real ones
    // were.
    expect(groupKey(shell('cd C:/src/demo && git grep -n foo'))).toBe('git grep');
    expect(groupKey(shell('cd "C:/a b" && npm run build'))).toBe('npm run build');
    expect(groupKey(shell('sudo -E env FOO=1 python script.py'))).toBe('python');
    expect(groupKey(shell('powershell -NoProfile -Command Get-ChildItem'))).toBe('get-childitem');
  });

  it('keeps the subcommand, because that is the unit that fails', () => {
    expect(groupKey(shell('git -C x rev-parse HEAD'))).toBe('git rev-parse');
    expect(groupKey(shell('dotnet build src/a.csproj'))).toBe('dotnet build');
    expect(groupKey(shell('npm run-script lint'))).toBe('npm run lint');
    expect(groupKey(shell('git'))).toBe('git');
  });

  it('refuses to name a failing statement a chained line does not record', () => {
    for (const line of [
      'cd X; git grep a; Select-String b',
      'npm ci && npm test',
      'ls | head -3',
    ]) {
      expect(groupKey(shell(line))).toBe(CHAINED);
    }
  });

  it('groups a shell failure by its command even when the output named a path', () => {
    // A "file not found" from a shell call names a path the call never mentioned: it
    // came out of the output. Grouping by the path's parent grouped by the directory
    // the command was typed in -- one group per session, and a rule from none.
    const key = groupKey(
      call({ subject: 'git grep -n zzz', subjectKind: SubjectKind.Command, category: FailureCategory.FileNotFound })
    );
    expect(key).toBe('git grep');
  });

  it('groups paths by the directory a set of missing files shares', () => {
    const missing = (path: string): ToolCall =>
      call({ name: 'Read', subject: path, subjectKind: SubjectKind.Path, category: FailureCategory.FileNotFound });
    expect(groupKey(missing('C:\\src\\gen\\a.cs'))).toBe('C:/src/gen');
    expect(groupKey(missing('C:/src/gen/b.cs'))).toBe('C:/src/gen');
  });

  it('is the tool itself when the tool rejected its own arguments', () => {
    const key = groupKey(
      call({ name: 'mcp__x__wiki_write', subject: 'a', subjectKind: SubjectKind.Path, category: FailureCategory.InvalidArguments })
    );
    expect(key).toBe('mcp__x__wiki_write');
  });

  it('is the tool when the call named no subject at all', () => {
    expect(groupKey(call({ name: 'TodoWrite' }))).toBe('TodoWrite');
  });
});
describe('analyse', () => {
  const run = (sessions: readonly SessionData[], unreadable: readonly string[] = []) =>
    analyse('claude', PROJECT, sessions, unreadable);

  it('reports a habit once, with what it cost', () => {
    const result = run([habit(4, { subject: 'gh pr view 1', subjectKind: SubjectKind.Command, outputBytes: 500 })]);
    expect(result.recommendations).toHaveLength(1);
    const [rule] = result.recommendations;
    expect(rule?.body).toContain('`gh pr` failed 4 times');
    expect(rule?.body).toContain('fatal: not a git repository');
    expect(rule?.occurrences).toBe(4);
    expect(rule?.wastedBytes).toBe(2000);
    expect(result.failures).toBe(4);
  });

  it('says nothing below the threshold, because twice is not a habit', () => {
    const one = { subject: 'gh pr view 1', subjectKind: SubjectKind.Command };
    expect(run([habit(MIN_OCCURRENCES - 1, one)]).recommendations).toHaveLength(0);
    expect(run([habit(MIN_OCCURRENCES, one)]).recommendations).toHaveLength(1);
  });

  it('counts a chained line as unattributable instead of blaming its first command', () => {
    const result = run([habit(5, { subject: 'cd X; git grep a; ls b', subjectKind: SubjectKind.Command })]);
    expect(result.unattributable).toBe(5);
    expect(result.recommendations).toHaveLength(0);
  });

  it('writes no rule from work failing', () => {
    // A failing build or test is the job going wrong, not a habit to avoid, and
    // "stop running the tests" is the advice that wording would produce.
    for (const category of [FailureCategory.BuildFailure, FailureCategory.TestFailure, FailureCategory.SyntaxError]) {
      const result = run([habit(6, { subject: 'dotnet test src', subjectKind: SubjectKind.Command, category })]);
      expect(result.recommendations).toHaveLength(0);
    }
    const built = run([habit(6, { subject: 'cd X && npm test', subjectKind: SubjectKind.Command })]);
    expect(built.recommendations).toHaveLength(0);
  });

  it('writes no rule from evidence that says nothing', () => {
    // 175 of 175 shell failures in one corpus quoted "Exit code 1" as their reason.
    // A rule whose evidence restates the category teaches nothing, so it is refused.
    for (const detail of ['', 'Exit code 1', 'exit code 137.']) {
      const result = run([habit(4, { subject: 'ffmpeg -i a.mp4', subjectKind: SubjectKind.Command, detail })]);
      expect(result.recommendations).toHaveLength(0);
    }
  });

  it('says nothing about a resource when it never learned which one', () => {
    // A code-mode tool records a program, not a path, so the key is the tool's own
    // name. "`exec` was read or written 9 times and does not exist" is what the path
    // wording produced from that on a real corpus -- false about the tool, and no
    // help in finding the file that was actually missing.
    for (const category of [
      FailureCategory.FileNotFound,
      FailureCategory.PermissionDenied,
      FailureCategory.NoMatches,
      FailureCategory.ConnectionError,
    ]) {
      const result = run([habit(9, { name: 'exec', category, detail: 'ENOENT: no such file' })]);
      expect(result.recommendations).toHaveLength(0);
    }
  });

  it('still names the tool for a failure that is about the tool', () => {
    const result = run([
      habit(4, {
        name: 'mcp__x__wiki_write',
        category: FailureCategory.InvalidArguments,
        detail: 'wiki_write requires claim, anchors',
      }),
    ]);
    expect(result.recommendations[0]?.body).toContain('`mcp__x__wiki_write` rejected its own arguments 4 times');
  });

  it('does not quote a JSON document as the reason something failed', () => {
    // A code-mode reply is JSON, and its first 200 characters were being quoted as
    // what the command said: a true count beside a quotation a reader cannot use.
    const blob = '{"type": "message", "id": "msg_0d61", "role": "assistant", "content": []}';
    const result = run([habit(50, { name: 'exec', detail: blob })]);
    expect(result.recommendations).toHaveLength(0);
  });

  it('counts what it could not read and what it could not categorise', () => {
    const result = run(
      [habit(3, { category: FailureCategory.Unknown, subject: 'x', subjectKind: SubjectKind.Command })],
      ['C:/logs/demo/broken.jsonl']
    );
    expect(result.uncategorised).toBe(3);
    expect(result.unreadable).toEqual(['C:/logs/demo/broken.jsonl']);
    expect(result.recommendations).toHaveLength(0);
  });
});