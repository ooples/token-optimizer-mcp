import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

function configuredPath(environment, name) {
  const value = String(environment?.[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  const path = isAbsolute(value) ? value : resolve(value);
  if (!existsSync(path)) throw new Error(`${name} does not exist: ${path}`);
  return path;
}

/**
 * Load an externally provisioned evidence-signing identity. Promotable
 * artifacts carry only its published key id; private key material and the
 * independently distributed verification key never enter the artifact.
 */
export function loadProvisionedEvidenceIdentity({
  environment = process.env,
  requirePrivate = true,
  expectedKeyId = null,
} = {}) {
  const keyId = String(environment?.UCR_EVIDENCE_SIGNING_KEY_ID || '').trim();
  if (!keyId) throw new Error('UCR_EVIDENCE_SIGNING_KEY_ID is required');
  if (expectedKeyId && keyId !== expectedKeyId)
    throw new Error(
      `configured evidence key ${keyId} does not match artifact key ${expectedKeyId}`
    );

  const publicKeyPath = configuredPath(
    environment,
    'UCR_EVIDENCE_PUBLIC_KEY_FILE'
  );
  const publicKey = createPublicKey(readFileSync(publicKeyPath, 'utf8'));
  if (!requirePrivate) return { keyId, publicKey, publicKeyPath };

  const privateKeyPath = configuredPath(
    environment,
    'UCR_EVIDENCE_PRIVATE_KEY_FILE'
  );
  const privateKey = createPrivateKey(readFileSync(privateKeyPath, 'utf8'));
  const challenge = randomBytes(32);
  const signature = sign(null, challenge, privateKey);
  if (!verify(null, challenge, publicKey, signature))
    throw new Error(
      'provisioned evidence private and public keys do not match'
    );
  return { keyId, privateKey, publicKey, privateKeyPath, publicKeyPath };
}

/**
 * Resolve the verification key for an evidence artifact. Promotable evidence
 * must name an externally provisioned key and may never authenticate itself
 * with public key material embedded in the artifact.
 */
export function resolveEvidenceVerificationPublicKey(
  report,
  {
    environment = process.env,
    promotable = false,
    trustedPublicKey = null,
  } = {}
) {
  if (report?.ledgerKeyId && trustedPublicKey)
    return createPublicKey(trustedPublicKey);
  if (report?.ledgerKeyId)
    return loadProvisionedEvidenceIdentity({
      environment,
      requirePrivate: false,
      expectedKeyId: report.ledgerKeyId,
    }).publicKey;
  if (promotable)
    throw new Error(
      'promotable evidence requires ledgerKeyId and an externally provisioned public key'
    );
  return report?.ledgerPublicKey
    ? createPublicKey(report.ledgerPublicKey)
    : null;
}
