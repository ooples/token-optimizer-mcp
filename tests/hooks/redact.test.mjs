// tests/hooks/redact.test.mjs
import { describe, it, expect } from '@jest/globals';
import { redact } from '../../hooks-core/redact.mjs';

describe('redact', () => {
  it('removes bearer tokens', () => {
    // This token does NOT start with sk-/pk-/ghp-/etc, so only the bearer
    // pattern can catch it -- isolates the bearer pattern from the
    // key-prefix pattern.
    // Asserted as a whole string, not as an absence. `not.toContain` alone is
    // also satisfied by redact() returning '' for every input -- that is, by the
    // function being wholly broken -- so it cannot tell removal apart from
    // destruction. Pinning the result proves the secret left AND that the
    // surrounding diagnostic text stayed.
    expect(redact('failed: Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345')).toBe(
      'failed: Authorization: Bearer [redacted]'
    );
  });
  it('removes API-key-shaped tokens', () => {
    // Not preceded by "Bearer", so only the sk-/pk-/ghp-/... prefix pattern
    // can catch it -- isolates the key-prefix pattern from the bearer
    // pattern.
    expect(redact('token=sk-abc123def456ghi789')).toBe('token=[redacted]');
  });
  it('removes assignments that look like secrets', () => {
    // The key NAME must survive; only its value goes. A reader who cannot see
    // WHICH credential leaked cannot rotate it.
    expect(redact('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG')).toBe(
      'AWS_SECRET_ACCESS_KEY=[redacted]'
    );
  });
  it('removes connection strings with credentials', () => {
    // Host, port, database and username all stay: they are the diagnostic value
    // of the string, and only the password is the secret.
    expect(redact('postgres://user:hunter2@db:5432/x')).toBe(
      'postgres://user:[redacted]@db:5432/x'
    );
  });
  it('removes PEM private key blocks', () => {
    const text = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----';
    expect(redact(text)).toBe('[redacted key]');
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
