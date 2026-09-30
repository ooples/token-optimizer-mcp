/**
 * Reading a failure.
 *
 * Two properties carry the whole feature. A category has to come from what the tool
 * actually said, because the category picks the wording of the advice and a wrong one
 * writes a confident wrong rule. And the evidence quoted beside it has to be the line
 * that explains the failure, not the first line of output -- a shell tool hands back
 * stdout and stderr in the order they happened, so the first line of a failed run is
 * usually the successful start of it.
 */
import { describe, it, expect } from '@jest/globals';
import { FailureCategory } from '../../../src/learn/models.js';
import {
  classifyFailure,
  classifyHeadBytes,
  failureDetail,
} from '../../../src/learn/classify.js';

describe('classifyFailure', () => {
  const cases: readonly (readonly [string, string, FailureCategory])[] = [
    ['Bash', 'Exit code 2\ngrep: src/a.cs: No such file or directory', FailureCategory.FileNotFound],
    ['Bash', 'Exit code 127\nbash: dotnet: command not found', FailureCategory.CommandNotFound],
    ['Bash', 'Exit code 143\nCommand timed out after 2m 0s', FailureCategory.Timeout],
    ['Bash', 'Exit code 1\nEACCES: permission denied, open "x"', FailureCategory.PermissionDenied],
    ['Bash', 'Exit code 137\nJavaScript heap out of memory', FailureCategory.OutOfMemory],
    ['Bash', 'Exit code 1\nError: Cannot find module "left-pad"', FailureCategory.ModuleNotFound],
    ['Bash', 'Exit code 7\ncurl: (7) Failed to connect to localhost port 9', FailureCategory.ConnectionError],
    ['Edit', 'String to replace not found in file.', FailureCategory.StringNotFound],
    ['Read', 'EISDIR: illegal operation on a directory, read', FailureCategory.IsDirectory],
    ['Read', 'File content (2.1MB) exceeds maximum allowed size', FailureCategory.FileTooLarge],
    ['Bash', '<tool_use_error>Blocked: sleep 240 followed by</tool_use_error>', FailureCategory.UserRejected],
    ['Bash', 'Exit code 1\nnothing here explains itself', FailureCategory.ExitCode],
    [
      'mcp__x__wiki_write',
      'wiki_write requires claim, evidence (required: claim, anchors).',
      FailureCategory.InvalidArguments,
    ],
    ['mcp__x__smart_grep', 'smart_grep does not accept contextLines (did you mean contextAfter?)', FailureCategory.InvalidArguments],
  ];
  for (const [tool, output, expected] of cases) {
    it(`reads ${expected} out of what ${tool} said`, () => {
      expect(classifyFailure(tool, output)).toBe(expected);
    });
  }

  it('leaves a silence uncategorised rather than guessing at one', () => {
    expect(classifyFailure('Bash', '   \n  ')).toBe(FailureCategory.Unknown);
    expect(classifyFailure('Write', 'something nobody has a pattern for')).toBe(
      FailureCategory.Unknown
    );
  });

  it('treats a search tool that said nothing as having matched nothing', () => {
    // The one place the tool name decides the answer: an empty failure from a
    // searcher IS the no-match, where the same silence from an editor is not.
    expect(classifyFailure('smart_grep', 'no matches')).toBe(FailureCategory.NoMatches);
    expect(classifyFailure('Grep', 'nothing to say about this')).toBe(FailureCategory.NoMatches);
    expect(classifyFailure('Write', 'nothing to say about this')).toBe(FailureCategory.Unknown);
  });

  it('reads a bounded head of the output and no more', () => {
    // A JavaScript regex cannot be given a timeout, so the guarantee here is the
    // bound: a pathological pattern cannot be fed a hundred megabytes of build log.
    const padding = 'x'.repeat(classifyHeadBytes * 4);
    expect(classifyFailure('Bash', `${padding}\nbash: nope: command not found`)).toBe(
      FailureCategory.Unknown
    );
    expect(classifyFailure('Bash', `bash: nope: command not found\n${padding}`)).toBe(
      FailureCategory.CommandNotFound
    );
  });

  it('prefers the more specific reading when two could apply', () => {
    // "requires" appears inside plenty of build output, and a build that failed for
    // its own reasons is not a tool refusing its arguments.
    expect(
      classifyFailure('Bash', 'Exit code 1\nerror CS0246: the type requires a reference')
    ).toBe(FailureCategory.BuildFailure);
  });
});

describe('failureDetail', () => {
  it('steps over the line that only restates the failure', () => {
    // THE REGRESSION THIS RULES OUT. Taking the first non-empty line made all 175
    // shell failures in one real transcript read "Exit code 1" -- the detail restated
    // the category and the message sat on the next line, unread.
    expect(failureDetail('Exit code 1\ngrep: a.cs: No such file or directory')).toBe(
      'grep: a.cs: No such file or directory'
    );
    expect(failureDetail('Error:\nCannot find module "x"')).toBe('Cannot find module "x"');
  });

  it('prefers a line that reads like an error over the first line', () => {
    const output = [
      'Exit code 1',
      '===== [1] PRRT_kwDO .github/workflows/release.yml:174',
      'ok so far',
      'Traceback (most recent call last):',
    ].join('\n');
    expect(failureDetail(output)).toBe('Traceback (most recent call last):');
  });

  it('falls back to the first real line, and then to the restatement', () => {
    expect(failureDetail('Exit code 1\nsome output nobody can read')).toBe(
      'some output nobody can read'
    );
    expect(failureDetail('Exit code 41')).toBe('Exit code 41');
    expect(failureDetail('')).toBe('');
  });

  it('clips a long line to the limit it was given', () => {
    const detail = failureDetail(`error: ${'y'.repeat(500)}`, 40);
    expect(detail.length).toBe(40);
    expect(detail.endsWith('...')).toBe(true);
  });
});