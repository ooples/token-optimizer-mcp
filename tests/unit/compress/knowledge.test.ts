import { describe, it, expect } from '@jest/globals';
import {
  DEFAULT_BUDGET_CHARS,
  injectKnowledge,
  knowledgeBlock,
  stableContext,
  type Finding,
} from '../../../src/compress/knowledge.js';
import { anchorStore } from '../../../src/compress/anchor.js';
import { v1Frontier } from '../../../src/compress/strategy.js';
import type { ProviderRequest } from '../../../src/compress/frontier.js';

/**
 * Findings in the cached prefix.
 *
 * The value here is turns, not tokens: this project measured a posture that
 * cut nothing and cost 1.471x control on extra turns alone. A finding that
 * prevents one wasted turn pays for a great deal of context -- but only if it
 * sits in the CACHED prefix, billed at 0.1x, and only if that prefix arrives
 * byte-identical every turn. The stability tests below are the ones that
 * matter: get them wrong and this costs 1.25x on everything instead.
 */

const findings: Finding[] = [
  {
    key: 'a',
    type: 'failure',
    claim: 'npm install bumps zod 3 to 4 and breaks tsc; use npm ci',
    confidence: 0.95,
    origin: 'agent',
  },
  {
    key: 'b',
    type: 'feedback',
    claim: 'Never weaken a test to make it pass',
    confidence: 0.99,
    origin: 'human',
  },
  {
    key: 'c',
    type: 'command',
    claim: 'The wiki search route is exercised by verify-wiki-interactions.mjs',
    confidence: 0.8,
    origin: 'agent',
  },
  {
    key: 'd',
    type: 'finding',
    claim: 'The dashboard renders charts from a vendored chart.umd.min.js',
    confidence: 0.7,
    origin: 'agent',
  },
];

describe('knowledgeBlock', () => {
  it('renders the findings as one budgeted block', () => {
    const block = knowledgeBlock(findings, 'zod tsc install');
    expect(block).toContain('npm ci');
    expect(block).toContain('Already established');
  });

  it('puts a human correction above an agent observation', () => {
    // A person's correction is not a guess, and it outranks anything inferred
    // regardless of what the session happens to be about.
    const block = knowledgeBlock(findings, 'chart dashboard vendored') ?? '';
    const human = block.indexOf('Never weaken');
    const agent = block.indexOf('vendored chart');
    expect(human).toBeGreaterThanOrEqual(0);
    expect(agent).toBeGreaterThanOrEqual(0);
    expect(human).toBeLessThan(agent);
  });

  it('says nothing when there is nothing worth saying', () => {
    // The common case in a project with no graph, and it has to stay free.
    expect(knowledgeBlock([], 'anything')).toBeNull();
    expect(knowledgeBlock([{ claim: '   ' }], 'anything')).toBeNull();
  });

  it('drops a finding nobody is confident in', () => {
    const unsure: Finding[] = [
      { claim: 'maybe the cache is cold', confidence: 0.2 },
    ];
    expect(knowledgeBlock(unsure, 'cache')).toBeNull();
  });

  it('never withdraws a retired finding into the prefix', () => {
    // Retired means a human took it back. The prefix is the highest-leverage
    // place in the request; a withdrawn claim there is a false statement made
    // on every turn of the session.
    const withRetired: Finding[] = [
      ...findings,
      {
        key: 'e',
        claim: 'RETRACTED: the proxy binds all interfaces',
        retired: true,
        confidence: 0.99,
      },
    ];
    const block = knowledgeBlock(withRetired, 'proxy bind') ?? '';
    expect(block).not.toContain('RETRACTED');
    expect(block).toContain('npm ci');
  });

  it('stays inside its budget', () => {
    const many: Finding[] = Array.from({ length: 200 }, (_, i) => ({
      key: `k${i}`,
      claim: `finding number ${i} about ${'padding '.repeat(10)}`,
      confidence: 0.9,
    }));
    const block = knowledgeBlock(many, 'finding padding') ?? '';
    expect(block.length).toBeLessThanOrEqual(DEFAULT_BUDGET_CHARS);
    // And it is not empty just because the budget was tight.
    expect(block).toContain('finding number');
  });

  it('is deterministic, which is what makes it cacheable at all', () => {
    // Two runs over the same graph and the same context must produce the same
    // bytes. If they do not, the prefix changes every turn and the injection
    // costs 1.25x on everything rather than 0.1x.
    const once = knowledgeBlock(findings, 'zod tsc install');
    const twice = knowledgeBlock([...findings].reverse(), 'zod tsc install');
    expect(once).toBe(twice);
  });
});

describe('stableContext', () => {
  it('reads the cached prefix, not the live question', () => {
    // Ranking against the latest turn would rewrite the block every turn.
    const request: ProviderRequest = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'cached history',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'the live question' }],
        },
      ],
    };
    const context = stableContext(request);
    expect(context).toContain('cached history');
    expect(context).not.toContain('the live question');
  });
});

describe('injectKnowledge', () => {
  it('appends to a string system prompt, keeping the host prompt first', () => {
    // The host's own prompt is the most stable text in the request; anything
    // inserted before it re-prices everything behind it.
    const out = injectKnowledge({ system: 'You are an agent.' }, 'BLOCK');
    expect(out.system).toBe('You are an agent.\n\nBLOCK');
  });

  it('appends a block to a structured system prompt', () => {
    const out = injectKnowledge(
      { system: [{ type: 'text', text: 'You are an agent.' }] },
      'BLOCK'
    );
    expect(Array.isArray(out.system) ? out.system.length : 0).toBe(2);
  });

  it('changes nothing when there is nothing to inject', () => {
    const request: ProviderRequest = { system: 'You are an agent.' };
    expect(injectKnowledge(request, null)).toBe(request);
  });
});

describe('through v1, where the cache economics live', () => {
  const session = (fresh: string): ProviderRequest => ({
    system: 'You are a coding agent.',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'start the task',
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: fresh }] },
    ],
  });

  const run = (
    request: ProviderRequest,
    anchors: ReturnType<typeof anchorStore>,
    withFindings = true
  ) => {
    const result = v1Frontier(request, {
      anchors,
      ...(withFindings ? { findings } : {}),
    });
    if (result.anchor)
      anchors.remember(result.anchor.key, result.anchor.record);
    return result;
  };

  it('injects nothing unless findings are supplied', () => {
    // Off by default. This is payload, not mechanism, and it has to be asked
    // for -- otherwise it is exactly the unrequested preamble we criticise.
    const out = run(session('go'), anchorStore(), false);
    expect(out.request.system).toBe('You are a coding agent.');
    expect(out.injectedChars).toBe(0);
  });

  it('puts the findings in the system prompt, inside the cached region', () => {
    const out = run(session('go'), anchorStore());
    expect(String(out.request.system)).toContain('Already established');
    expect(out.injectedChars).toBeGreaterThan(0);
  });

  it('sends BYTE-IDENTICAL system text on the next turn', () => {
    // THE TEST THIS FILE EXISTS FOR. Re-selecting findings against the new
    // question each turn is the obvious implementation and it is the one that
    // converts a 0.1x read into a 1.25x write on the whole prefix.
    const anchors = anchorStore();
    const one = run(session('look at the zod problem'), anchors);
    const two = run(session('now something completely different'), anchors);

    expect(String(two.request.system)).toBe(String(one.request.system));
  });

  it('does not rewrite the prefix when the graph grows mid-session', () => {
    // THE CASE THE REPLAY EXISTS FOR, and it is not hypothetical: a session
    // that calls wiki_write adds findings to the graph while it is running.
    // Re-selecting on the next turn would then produce a different block over
    // an otherwise unchanged prefix -- a 1.25x write on everything, bought for
    // one extra line of advice.
    const anchors = anchorStore();
    const before = v1Frontier(session('go'), { anchors, findings });
    if (before.anchor)
      anchors.remember(before.anchor.key, before.anchor.record);

    const grown: Finding[] = [
      ...findings,
      {
        key: 'z',
        type: 'failure',
        claim: 'A brand new conclusion written during this very session',
        confidence: 0.99,
        origin: 'human',
      },
    ];
    const after = v1Frontier(session('go'), { anchors, findings: grown });

    expect(String(after.request.system)).toBe(String(before.request.system));
    expect(String(after.request.system)).not.toContain('brand new conclusion');
  });

  it('takes the new finding once the prefix is being rewritten anyway', () => {
    // The other half: the replay is a deferral, not a refusal. When the client
    // changes history the miss has already happened, so the block is rebuilt
    // and everything learned since is picked up.
    const anchors = anchorStore();
    const first = v1Frontier(session('go'), { anchors, findings });
    if (first.anchor) anchors.remember(first.anchor.key, first.anchor.record);

    const grown: Finding[] = [
      ...findings,
      {
        key: 'z',
        type: 'failure',
        claim: 'A brand new conclusion written during this very session',
        confidence: 0.99,
        origin: 'human',
      },
    ];
    // A different cached prefix: the client edited history or compacted.
    const edited = session('go');
    const content = edited.messages?.[0].content;
    if (Array.isArray(content)) content[0].text = 'start the task, revised';

    const after = v1Frontier(edited, { anchors, findings: grown });
    expect(String(after.request.system)).toContain('brand new conclusion');
  });
  it('does not start injecting into a conversation it declined to anchor', () => {
    // Joining mid-conversation, the provider probably holds the client's
    // original prefix. Adding a block there is precisely the cache miss this
    // design exists to avoid.
    const big = 'history '.repeat(6000);
    const joined: ProviderRequest = {
      system: 'You are a coding agent.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'opening' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: big, cache_control: { type: 'ephemeral' } },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'go on' }] },
      ],
    };
    const out = run(joined, anchorStore());
    expect(out.request.system).toBe('You are a coding agent.');
    expect(out.injectedChars).toBe(0);
  });

  it('charges itself honestly for what it added', () => {
    // The same column the CCR control arm is charged on. An injection that is
    // not counted is a reduction figure that is not true.
    const out = run(session('go'), anchorStore());
    const block = String(out.request.system).replace(
      'You are a coding agent.\n\n',
      ''
    );
    expect(out.injectedChars).toBe(block.length);
  });
});
