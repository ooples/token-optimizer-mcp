// tests/hooks/redact.test.mjs
import { describe, it, expect } from '@jest/globals';
import { redact } from '../../hooks-core/redact.mjs';

describe('redact', () => {
  it('removes bearer tokens', () => {
    expect(redact('failed: Authorization: Bearer sk-abc123def456ghi789')).not.toContain('sk-abc123');
  });
  it('removes assignments that look like secrets', () => {
    expect(redact('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG')).not.toContain('wJalrXUtnFEMI');
  });
  it('removes connection strings with credentials', () => {
    expect(redact('postgres://user:hunter2@db:5432/x')).not.toContain('hunter2');
  });
  it('keeps ordinary error text intact', () => {
    const text = 'TS2345: Argument of type string is not assignable to number';
    expect(redact(text)).toBe(text);
  });
  it('caps length', () => {
    expect(redact('x'.repeat(5000), { max: 400 }).length).toBeLessThanOrEqual(400);
  });
  it('never throws on non-string input', () => {
    expect(() => redact(null)).not.toThrow();
  });
});
