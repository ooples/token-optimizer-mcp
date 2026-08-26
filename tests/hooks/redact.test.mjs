// tests/hooks/redact.test.mjs
import { describe, it, expect } from '@jest/globals';
import { redact } from '../../hooks-core/redact.mjs';

describe('redact', () => {
  it('removes bearer tokens', () => {
    // This token does NOT start with sk-/pk-/ghp-/etc, so only the bearer
    // pattern can catch it -- isolates the bearer pattern from the
    // key-prefix pattern.
    expect(redact('failed: Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345')).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
  });
  it('removes API-key-shaped tokens', () => {
    // Not preceded by "Bearer", so only the sk-/pk-/ghp-/... prefix pattern
    // can catch it -- isolates the key-prefix pattern from the bearer
    // pattern.
    expect(redact('token=sk-abc123def456ghi789')).not.toContain('sk-abc123');
  });
  it('removes assignments that look like secrets', () => {
    expect(redact('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG')).not.toContain('wJalrXUtnFEMI');
  });
  it('removes connection strings with credentials', () => {
    expect(redact('postgres://user:hunter2@db:5432/x')).not.toContain('hunter2');
  });
  it('removes PEM private key blocks', () => {
    const text = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----';
    expect(redact(text)).not.toContain('MIIBOgIBAAJBAK');
  });
  it('leaves non-private-key PEM-shaped blocks alone', () => {
    const text = '-----BEGIN CERTIFICATE-----\nMIIBOgIBAAJBAK\n-----END CERTIFICATE-----';
    expect(redact(text)).toBe(text);
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
    expect(() => redact(undefined)).not.toThrow();
  });
  it('turns a missing value into an empty string, not the literal text "null"/"undefined"', () => {
    // Without the `?? ''` guard, String(null) === 'null' and
    // String(undefined) === 'undefined' -- neither throws, so a garbage
    // four-character claim would silently reach the graph and model
    // context instead of surfacing as a failure.
    expect(redact(null)).toBe('');
    expect(redact(undefined)).toBe('');
  });
});
