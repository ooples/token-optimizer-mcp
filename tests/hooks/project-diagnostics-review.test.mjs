import { expect, test } from '@jest/globals';
import { foldOutput } from '../../src/hooks-core/output-compact.mjs';

test('bare project diagnostics keep different project paths distinct', () => {
  const a = '/a/First.csproj : warning NU1903: Vulnerable dependency';
  const b = '/b/Second.csproj : warning NU1903: Vulnerable dependency';
  expect(foldOutput(`${a}\n${b}`).text).toBe(`${a}\n${b}`);
});

test('bare and bracketed copies of one project diagnostic fold together', () => {
  const a = '/a/First.csproj : warning NU1903: Vulnerable dependency';
  const result = foldOutput(`${a}\n${a} [/a/First.csproj]`);
  expect(result.folded).toBe(1);
  expect(result.text).toContain(a);
});

test('positioned diagnostics without project suffixes do not lose file or line identity', () => {
  const lines = ['a.cs(1,2): error CS0001: problem', 'b.cs(4,5): error CS0001: problem'];
  expect(foldOutput(lines.join('\n')).text).toBe(lines.join('\n'));
});
