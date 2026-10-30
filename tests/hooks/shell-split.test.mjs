/**
 * The shared shell scanner (hooks-core/shell-split.mjs): operators split a
 * command only outside quotes, and only outside comments.
 */

import { describe, expect, test } from '@jest/globals';
import { shellStatements } from '../../hooks-core/shell-split.mjs';

describe('shellStatements', () => {
  test.each([
    ["awk 'NR>=10 && NR<=60' a.cs", [["awk 'NR>=10 && NR<=60' a.cs"]]],
    ["sed -n '1,20p;40,60p' a.cs", [["sed -n '1,20p;40,60p' a.cs"]]],
    ['make 2>&1 | tail -5', [['make 2>&1', 'tail -5']]],
    ['cd a && npm test', [['cd a'], ['npm test']]],
  ])('quoted operators stay literal: %j', (command, expected) => {
    expect(shellStatements(command)).toEqual(expected);
  });

  test('an apostrophe in a comment does not swallow the next line', () => {
    expect(shellStatements("# Run the API's tests\ncd packages/api && npm test")).toEqual([
      ['cd packages/api'],
      ['npm test'],
    ]);
  });

  test('a trailing comment ends at its line', () => {
    expect(shellStatements("npm test # don't cache\necho done")).toEqual([
      ['npm test'],
      ['echo done'],
    ]);
  });

  test('a heredoc body is data, not statements', () => {
    const command =
      "cat > probe.py <<'EOF'\nhead = 1  # it's here\nprint('a; b | c')\nEOF\npython probe.py && echo ok";
    expect(shellStatements(command)).toEqual([
      ["cat > probe.py <<'EOF'"],
      ['python probe.py'],
      ['echo ok'],
    ]);
  });

  test('<<- strips leading tabs from the terminator; <<< is a herestring', () => {
    expect(shellStatements('cat <<-END\n\tx; y\n\tEND\nls')).toEqual([['cat <<-END'], ['ls']]);
    expect(shellStatements('grep x <<< "a;b"; ls')).toEqual([['grep x <<< "a;b"'], ['ls']]);
  });

  test.each([
    ['echo a#b', [['echo a#b']]],
    ["curl 'https://x/y#frag'", [["curl 'https://x/y#frag'"]]],
    ['echo "${#arr[@]}"', [['echo "${#arr[@]}"']]],
    ['echo $#', [['echo $#']]],
  ])('a # inside a word or quotes is literal: %j', (command, expected) => {
    expect(shellStatements(command)).toEqual(expected);
  });
});
