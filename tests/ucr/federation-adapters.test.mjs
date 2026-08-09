import { describe, expect, test } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';
import {
  BOOTSTRAP_COGNITIVE_OPERATIONS,
  FederationPolicy,
  UCR_CLIENT_REGISTRY,
  certifyAdapter,
  negotiateCapabilities,
  redactSecrets,
  safeFederatedCapsule,
  signedBundle,
  surfaceOverhead,
  taintJoin,
  verifyBundle,
} from '../../ucr/index.mjs';

describe('secure cross-project federation', () => {
  const grant = {
    id: 'grant-1',
    operation: 'retrieve',
    sourceTenant: 'tenant-a',
    targetTenant: 'tenant-b',
    maximumScope: 'organization',
  };
  const target = {
    tenantId: 'tenant-b',
    scope: { level: 'project' },
    compatibility: {
      language: 'js',
      framework: 'node',
      frameworkVersion: '22.1',
      policyHash: 'p',
    },
  };
  const object = {
    id: 'claim:a',
    type: 'claim',
    tenantId: 'tenant-a',
    sensitivity: 'internal',
    scope: { level: 'project', projectId: 'source-project' },
    compatibility: {
      language: 'js',
      framework: 'node',
      frameworkVersion: '22.9',
      policyHash: 'p',
    },
    claim: 'Use npm test',
    applicability: ['node project'],
  };

  test('authorizes only compatible, granted, unrevoked scope with an explanation', () => {
    const policy = new FederationPolicy({
      principal: 'user',
      tenantId: 'tenant-b',
      grants: [grant],
    });
    const authorization = policy.authorize(object, target);
    expect(authorization).toMatchObject({
      authorized: true,
      grantId: 'grant-1',
    });
    expect(safeFederatedCapsule(object, authorization)).toMatchObject({
      objectId: 'claim:a',
      authorizedBy: 'grant-1',
      contentIsData: true,
      executable: false,
    });
    policy.revoke(object.id, 'withdrawn');
    expect(policy.authorize(object, target)).toMatchObject({
      authorized: false,
      denied: ['object revoked'],
    });
  });

  test('denies cross-tenant, incompatible, and secret-bearing attacks', () => {
    const policy = new FederationPolicy({ grants: [grant] });
    expect(
      policy.authorize({ ...object, sensitivity: 'restricted' }, target)
        .authorized
    ).toBe(false);
    expect(
      policy.authorize(
        {
          ...object,
          compatibility: { ...object.compatibility, framework: 'python' },
        },
        target
      ).authorized
    ).toBe(false);
    const secret = { ...object, claim: 'api_key=abcdefghijklmnop' };
    expect(redactSecrets(secret).changed).toBe(true);
    expect(
      safeFederatedCapsule(secret, policy.authorize(secret, target))
    ).toBeNull();
    expect(taintJoin('internal', 'untrusted')).toBe('untrusted');
  });

  test('requires both a valid signature and explicit executable authorization', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const policy = new FederationPolicy({
      grants: [{ ...grant, operation: 'execute-guard' }],
    });
    const guard = { ...object, type: 'guard', executableAuthorized: true };
    const bundle = signedBundle(
      { objects: [guard], publisher: 'tenant-a' },
      privateKey
    );
    expect(verifyBundle(bundle, publicKey, policy, target)).toMatchObject({
      valid: true,
      validSignature: true,
      executable: true,
    });
    expect(
      verifyBundle(
        { ...bundle, publisher: 'attacker' },
        publicKey,
        policy,
        target
      ).valid
    ).toBe(false);
  });
});

describe('minimal lazy capability surface and adapter SDK', () => {
  test('exposes exactly four bootstrap cognitive operations with migration aliases', () => {
    expect(BOOTSTRAP_COGNITIVE_OPERATIONS).toHaveLength(4);
    const capabilities = negotiateCapabilities({
      dynamicExposure: true,
      requested: ['benchmark_run'],
      advanced: ['benchmark_run'],
    });
    expect(capabilities.operations).toHaveLength(5);
    expect(capabilities.migration).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          legacy: 'wiki_read',
          replacement: 'context_page',
        }),
      ])
    );
    expect(
      surfaceOverhead({ schemas: BOOTSTRAP_COGNITIVE_OPERATIONS })
    ).toMatchObject({ roundTrips: 0 });
  });

  test('certifies all sixteen clients without inventing executable smoke evidence', () => {
    const fixture = [
      {
        kind: 'session_start',
        required: true,
        traceId: 'trace',
        wallMs: 100,
        payload: { task: 'x' },
      },
      {
        kind: 'tool_call',
        required: true,
        traceId: 'trace',
        wallMs: 101,
        payload: { tool: 'read' },
      },
      {
        kind: 'outcome',
        required: true,
        traceId: 'trace',
        wallMs: 102,
        payload: { correct: true },
      },
    ];
    const results = Object.keys(UCR_CLIENT_REGISTRY).map((client) =>
      certifyAdapter(client, fixture)
    );
    expect(results).toHaveLength(16);
    expect(results.every((result) => result.certified)).toBe(true);
    expect(
      results.every((result) => result.executableSmoke === 'unexercised')
    ).toBe(true);
    expect(new Set(results.map((result) => result.family))).toEqual(
      new Set(['process-hook', 'in-process-plugin', 'mcp-only', 'rules-only'])
    );
  });

  test('two client adapters produce the same canonical event vocabulary', () => {
    const fixture = [
      {
        kind: 'tool_call',
        required: true,
        traceId: 'trace',
        wallMs: 100,
        payload: { tool: 'read' },
      },
      {
        kind: 'tool_result',
        required: true,
        traceId: 'trace',
        wallMs: 101,
        payload: { success: true },
      },
    ];
    const codex = certifyAdapter('codex', fixture);
    const claude = certifyAdapter('claude-code', fixture);
    expect(codex.events.map((event) => event.type)).toEqual(
      claude.events.map((event) => event.type)
    );
    expect(codex.events.map((event) => event.payloadHash)).toEqual(
      claude.events.map((event) => event.payloadHash)
    );
  });
});
