import { describe, expect, test } from '@jest/globals';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexStudyDynamicTools,
  createModelAttestation,
  executeCodexStudyDynamicTool,
  parseLiveCliTelemetry,
  parseStructuredModelJson,
  studyArmDecision,
  validateModelAttestation,
  verifyStudySemanticEvidence,
} from '../../ucr/index.mjs';

describe('live study driver protocol helpers', () => {
  test('normalizes Codex JSONL without retaining model content', () => {
    const telemetry = parseLiveCliTelemetry(
      'codex',
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: '{"correction":"verified"}' },
        }),
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 12, output_tokens: 3 },
        }),
      ].join('\n')
    );
    expect(telemetry).toMatchObject({
      providerRequestId: 'thread-1',
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
      structuredOutput: { correction: 'verified' },
    });
    expect(telemetry).not.toHaveProperty('objects');
  });

  test('finds nested Claude structured output', () => {
    const telemetry = parseLiveCliTelemetry(
      'claude-code',
      JSON.stringify({
        type: 'result',
        session_id: 'session-1',
        payload: { structured_output: { correction: 'nested result' } },
        usage: { input_tokens: 9, output_tokens: 2 },
      })
    );
    expect(telemetry).toMatchObject({
      providerRequestId: 'session-1',
      structuredOutput: { correction: 'nested result' },
      usage: { inputTokens: 9, outputTokens: 2, totalTokens: 11 },
    });
  });

  test('uses terminal cumulative usage instead of an early streamed snapshot', () => {
    const telemetry = parseLiveCliTelemetry(
      'claude-code',
      [
        JSON.stringify({
          type: 'message',
          usage: { input_tokens: 2, output_tokens: 1 },
        }),
        JSON.stringify({
          type: 'result',
          usage: { input_tokens: 62003, output_tokens: 812 },
          total_tokens: 62815,
          total_cost_usd: 0.42,
        }),
      ].join('\n')
    );
    expect(telemetry.usage).toEqual({
      inputTokens: 62003,
      cachedInputTokens: null,
      cacheCreationInputTokens: null,
      effectiveInputTokens: 62003,
      outputTokens: 812,
      totalTokens: 62815,
      costUsd: 0.42,
    });
  });

  test('counts Claude cache-backed input without double-counting other clients', () => {
    const sample = JSON.stringify({
      type: 'result',
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 55000,
        cache_creation_input_tokens: 700,
        output_tokens: 12,
      },
    });
    expect(parseLiveCliTelemetry('claude-code', sample).usage).toMatchObject({
      inputTokens: 2,
      cachedInputTokens: 55000,
      cacheCreationInputTokens: 700,
      effectiveInputTokens: 55702,
    });
    expect(
      parseLiveCliTelemetry('codex', sample).usage.effectiveInputTokens
    ).toBe(2);
  });

  test('does not let a later null structured output erase valid model JSON', () => {
    const telemetry = parseLiveCliTelemetry(
      'codex',
      [
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: '{"correction":"keep this"}' },
        }),
        JSON.stringify({ type: 'result', structured_output: null }),
      ].join('\n')
    );
    expect(telemetry.structuredOutput).toEqual({ correction: 'keep this' });
  });

  test('parses fenced model JSON and fails closed on prose', () => {
    expect(parseStructuredModelJson('```json\n{"ok":true}\n```')).toEqual({
      ok: true,
    });
    expect(parseStructuredModelJson('no structured result')).toBeNull();
    expect(parseStructuredModelJson('[{"ok":true}]')).toBeNull();
    expect(parseStructuredModelJson('true')).toBeNull();
  });

  test('binds provider model evidence to one exact request and rejects reroutes', () => {
    const attestation = createModelAttestation({
      client: 'codex',
      provider: 'openai',
      requestedModel: 'gpt-5.6-sol',
      effectiveModel: 'gpt-5.6-sol',
      source: 'codex-app-server/thread-start',
      providerRequestId: 'thread-1',
      evidence: { catalogHash: 'catalog-1', turnId: 'turn-1' },
    });
    expect(
      validateModelAttestation(attestation, {
        client: 'codex',
        requestedModel: 'gpt-5.6-sol',
        providerRequestId: 'thread-1',
      })
    ).toEqual({ valid: true, diagnostics: [] });
    expect(
      validateModelAttestation(
        createModelAttestation({
          ...attestation,
          requestedModel: 'gpt-5.6-sol',
          effectiveModel: 'gpt-5.4',
          reroutes: [
            {
              fromModel: 'gpt-5.6-sol',
              toModel: 'gpt-5.4',
              reason: 'fallback',
            },
          ],
        }),
        {
          client: 'codex',
          requestedModel: 'gpt-5.6-sol',
          providerRequestId: 'thread-1',
        }
      ).valid
    ).toBe(false);
    expect(
      validateModelAttestation(
        createModelAttestation({
          client: 'codex',
          provider: 'google',
          requestedModel: 'gpt-5.6-sol',
          effectiveModel: 'gpt-5.6-sol',
          source: 'antigravity/stream-json',
          providerRequestId: 'thread-1',
          evidence: {},
        }),
        {
          client: 'codex',
          requestedModel: 'gpt-5.6-sol',
          providerRequestId: 'thread-1',
        }
      ).valid
    ).toBe(false);
    expect(
      validateModelAttestation(
        createModelAttestation({
          client: 'codex',
          provider: 'openai',
          requestedModel: 'gpt-5.6-sol',
          effectiveModel: 'gpt-5.6-sol',
          source: 'codex-app-server/thread-start',
          providerRequestId: null,
          evidence: {},
        }),
        { client: 'codex', requestedModel: 'gpt-5.6-sol' }
      ).valid
    ).toBe(false);
  });

  test('confines plugin-free Codex study tools to read evidence and write result.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'ucr-study-tools-'));
    try {
      writeFileSync(join(root, 'evidence.json'), '{"answer":"CURRENT"}\n');
      expect(codexStudyDynamicTools(false).map((tool) => tool.name)).toEqual([
        'list_workspace',
        'read_file',
      ]);
      expect(codexStudyDynamicTools(true).map((tool) => tool.name)).toEqual([
        'list_workspace',
        'read_file',
        'write_result',
      ]);
      expect(
        executeCodexStudyDynamicTool(
          { tool: 'read_file', arguments: { path: 'evidence.json' } },
          root,
          false
        )
      ).toMatchObject({ path: 'evidence.json' });
      expect(() =>
        executeCodexStudyDynamicTool(
          { tool: 'read_file', arguments: { path: '../outside.json' } },
          root,
          false
        )
      ).toThrow('escapes the isolated workspace');
      executeCodexStudyDynamicTool(
        {
          tool: 'write_result',
          arguments: { answer: 'CURRENT', receipts: ['verified'] },
        },
        root,
        true
      );
      expect(JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'))).toEqual(
        { answer: 'CURRENT', receipts: ['verified'] }
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('delivers only applicable runtime or oracle context', () => {
    expect(
      studyArmDecision('runtime', null, {
        correction: 'use current evidence',
        verificationEvidence: 'evidence/current.json',
        applicability: ['current evidence exists'],
      }, {
        verified: true,
        anchors: [
          { path: 'evidence/current.json', sha256: 'a'.repeat(64) },
        ],
      })
    ).toMatchObject({ applicable: true, delivered: true });
    expect(studyArmDecision('runtime', null, {}, null)).toMatchObject({
      applicable: true,
      eligible: false,
      delivered: false,
    });
    for (const arm of [
      'empty',
      'stale',
      'irrelevant',
      'contradictory',
      'harmful',
    ])
      expect(studyArmDecision(arm, 'hostile', {})).toMatchObject({
        applicable: false,
        delivered: false,
      });
  });

  test('grounds semantic capture in confined repository evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'ucr-semantic-evidence-'));
    try {
      writeFileSync(join(root, 'TASK.md'), '# Task\n');
      writeFileSync(join(root, 'current.json'), '{"answer":"CURRENT"}\n');
      const verified = verifyStudySemanticEvidence(
        {
          evidenceRefs: ['TASK.md', 'current.json'],
          verificationEvidence: 'Inspected TASK.md and current.json',
        },
        root
      );
      expect(verified).toMatchObject({
        verified: true,
        anchors: expect.arrayContaining([
          { path: 'TASK.md', bytes: 7, sha256: expect.any(String) },
          { path: 'current.json', bytes: 21, sha256: expect.any(String) },
        ]),
      });
      expect(
        verifyStudySemanticEvidence(
          { evidenceRefs: ['../outside.json'] },
          root
        ).verified
      ).toBe(false);
      expect(
        verifyStudySemanticEvidence(
          {
            evidenceRefs: ['current.json', 'missing.json'],
            verificationEvidence: 'Inspected current.json',
          },
          root
        ).verified
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
