import assert from 'node:assert/strict';
import { describe, it } from '@jest/globals';
import { SemanticHarvestController } from '../../ucr/index.mjs';

const semanticObject = {
  trigger: 'continue task one',
  attemptedAction: 'use STALE-1',
  observedFailure: 'fixture rejected STALE-1',
  rootCause: 'stale code mismatched',
  correction: 'use GREEN-1',
  verificationEvidence: 'external fixture accepted GREEN-1',
  applicability: ['task one'],
  nonApplicability: ['any other task'],
  invalidators: ['authenticated evidence is superseded'],
  scope: { taskId: 'one' },
  confidence: 1,
  confidenceLabel: 'verified',
  expectedOutcome: 'task succeeds',
};

describe('SemanticHarvestController', () => {
  it('authenticates first, lets the active model author, then persists exact bytes', async () => {
    const order = [];
    let persistedObject;
    const controller = new SemanticHarvestController({
      verifyEvidence: async () => {
        order.push('verify');
        return { valid: true, receipts: [{ observations: { corrected: true } }] };
      },
      persist: async ({ semanticObject: object }) => {
        order.push('persist');
        persistedObject = object;
        return { accepted: true, object: { id: 'failure:one' }, eventIds: ['e1'] };
      },
    });
    const result = await controller.harvest(
      {
        kind: 'failure',
        evidenceReceipts: [{ signature: 'signed' }],
        taskId: 'one',
        sessionId: 'producer',
        scope: { taskId: 'one' },
      },
      async ({ prompt }) => {
        order.push('model');
        assert.match(prompt, /externally authenticated/);
        assert.match(prompt, /not your personal session history/);
        return JSON.stringify(semanticObject);
      }
    );
    assert.deepEqual(order, ['verify', 'model', 'persist']);
    assert.deepEqual(persistedObject, semanticObject);
    assert.equal(result.receipt.modelAuthored, true);
    assert.equal(result.receipt.evidenceAuthenticatedBeforeAuthoring, true);
  });

  it('does not invoke the model when evidence authentication fails', async () => {
    let invoked = false;
    const controller = new SemanticHarvestController({
      verifyEvidence: async () => ({ valid: false }),
      persist: async () => assert.fail('must not persist'),
    });
    await assert.rejects(
      controller.harvest(
        {
          kind: 'failure',
          evidenceReceipts: [{}],
          taskId: 'one',
          scope: {},
        },
        async () => {
          invoked = true;
        }
      ),
      /authentication failed/
    );
    assert.equal(invoked, false);
  });

  it('retries invalid model JSON once and persists only the valid harvest', async () => {
    let attempts = 0;
    let persists = 0;
    const controller = new SemanticHarvestController({
      verifyEvidence: async () => ({ valid: true, receipts: [{}] }),
      persist: async () => {
        persists++;
        return { accepted: true, object: { id: 'failure:one' } };
      },
    });
    const result = await controller.harvest(
      {
        kind: 'failure',
        evidenceReceipts: [{}],
        taskId: 'one',
        scope: {},
      },
      async ({ prompt, attempt }) => {
        attempts++;
        if (attempt === 1) return 'not json';
        assert.match(prompt, /Correct the prior rejected output/);
        return `\`\`\`json\n${JSON.stringify(semanticObject)}\n\`\`\``;
      }
    );
    assert.equal(attempts, 2);
    assert.equal(persists, 1);
    assert.equal(result.receipt.attempts, 2);
  });
});
