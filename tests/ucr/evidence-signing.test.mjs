import { afterEach, describe, expect, test } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProvisionedEvidenceIdentity } from '../../ucr/index.mjs';

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('provisioned evidence identity', () => {
  test('loads matching external Ed25519 keys without embedding them in evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'ucr-evidence-key-'));
    roots.push(root);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyPath = join(root, 'private.pem');
    const publicKeyPath = join(root, 'public.pem');
    writeFileSync(
      privateKeyPath,
      privateKey.export({ type: 'pkcs8', format: 'pem' })
    );
    writeFileSync(
      publicKeyPath,
      publicKey.export({ type: 'spki', format: 'pem' })
    );
    const environment = {
      UCR_EVIDENCE_SIGNING_KEY_ID: 'published-key-v1',
      UCR_EVIDENCE_PRIVATE_KEY_FILE: privateKeyPath,
      UCR_EVIDENCE_PUBLIC_KEY_FILE: publicKeyPath,
    };
    expect(loadProvisionedEvidenceIdentity({ environment })).toMatchObject({
      keyId: 'published-key-v1',
    });
    expect(() =>
      loadProvisionedEvidenceIdentity({
        environment,
        requirePrivate: false,
        expectedKeyId: 'another-key',
      })
    ).toThrow(/does not match artifact key/);
  });
});
