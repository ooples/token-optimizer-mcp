#!/usr/bin/env node
/** Provision operator-owned study signing and hidden-variant material. */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { canonicalJson, sha256 } from '../ucr/index.mjs';

const configured =
  process.argv[2] ||
  process.env.TOKEN_OPTIMIZER_UCR_IDENTITY_DIR ||
  join(homedir(), '.token-optimizer-mcp', 'ucr-study-identity');
const root = isAbsolute(configured) ? configured : resolve(configured);
const privateKeyPath = join(root, 'evidence-private.pem');
const publicKeyPath = join(root, 'evidence-public.pem');
const studySecretPath = join(root, 'study-secret.txt');
mkdirSync(root, { recursive: true });

const present = [privateKeyPath, publicKeyPath, studySecretPath].map(
  existsSync
);
if (present.some(Boolean) && !present.every(Boolean))
  throw new Error(
    'refusing to replace a partial study identity; restore or remove the named files explicitly'
  );
if (!present.every(Boolean)) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(
    privateKeyPath,
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 }
  );
  writeFileSync(
    publicKeyPath,
    publicKey.export({ type: 'spki', format: 'pem' }),
    { mode: 0o600 }
  );
  writeFileSync(studySecretPath, randomBytes(48).toString('base64url'), {
    mode: 0o600,
  });
}
for (const path of [privateKeyPath, publicKeyPath, studySecretPath])
  chmodSync(path, 0o600);

const privateKey = createPrivateKey(readFileSync(privateKeyPath, 'utf8'));
const publicKeyText = readFileSync(publicKeyPath, 'utf8');
const publicKey = createPublicKey(publicKeyText);
const challenge = randomBytes(32);
const signature = sign(null, challenge, privateKey);
if (!verify(null, challenge, publicKey, signature))
  throw new Error('provisioned study identity has a mismatched keypair');
const studySecret = readFileSync(studySecretPath, 'utf8').trim();
if (studySecret.length < 32)
  throw new Error('provisioned hidden-variant secret is too short');
process.stdout.write(
  canonicalJson({
    root,
    keyId: `ucr-ed25519-${sha256(publicKeyText).slice(0, 20)}`,
    privateKeyPath,
    publicKeyPath,
    studySecretPath,
    created: !present.every(Boolean),
  })
);
