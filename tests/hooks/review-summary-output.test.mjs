import { expect, test } from '@jest/globals';
import { foldOutput } from '../../src/hooks-core/output-compact.mjs';

test('project warnings retain bracketed message text', () => {
  const warnings = ['App.csproj : warning ABC123: Check [net8.0]', 'App.csproj : warning ABC123: Check [net9.0]'];
  const result = foldOutput(warnings.join('\n'));
  expect(result.folded).toBe(0);
  for (const warning of warnings) expect(result.text).toContain(warning);
});

test('actual project suffixes still fold repeated diagnostics', () => {
  const warning = 'App.csproj : warning ABC123: Check [net8.0]';
  const result = foldOutput([warning+' [/repo/App.csproj::TargetFramework=net8.0]', warning+' [/repo/App.csproj::TargetFramework=net9.0]'].join('\n'));
  expect(result.folded).toBe(1);
  expect(result.text).toContain(warning);
});
