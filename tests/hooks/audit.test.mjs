/**
 * The audit surface, and dollars.
 *
 * The properties under test are the ones that make this a queue rather than a
 * fifth report: it is ranked by measured cost with an apply path per line, it
 * drops what is already fixed, it stops repeating advice that has been
 * declined, it reports what applied fixes ACTUALLY saved rather than what they
 * promised, it measures whether a habit changed after the advice, it never puts
 * a dollar figure on an unmeasured saving, and it is held to its own standard by
 * stopping where printing costs more than the finding is worth.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { record, recordRead } from '../../hooks-core/metrics.mjs';
import {
  buildQueue,
  renderAudit,
  decline,
  declines,
  habitTrend,
  raise,
  DECLINE_LIMIT,
} from '../../hooks-core/audit.mjs';
import { applyRemedy } from '../../hooks-core/remedy.mjs';
import {
  dollars,
  money,
  monthly,
  prices,
  priceNote,
} from '../../hooks-core/pricing.mjs';
import { detect } from '../../hooks-core/waste.mjs';

let workspace;
let dir;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'audit-'));
  dir = join(workspace, '.token-optimizer', 'wiki');
  delete process.env.TOKEN_OPTIMIZER_PRICES;
  delete process.env.TOKEN_OPTIMIZER_EFFECTIVE_INPUT_USD_PER_MILLION;
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  delete process.env.TOKEN_OPTIMIZER_PRICES;
  delete process.env.TOKEN_OPTIMIZER_EFFECTIVE_INPUT_USD_PER_MILLION;
});

const read = (sessionId, anchor, tokens) =>
  recordRead(dir, { sessionId, anchor, bytes: tokens * 4 });

const finding = (over) => ({
  id: 'barren-anchor',
  title: 'schema.ts: read in 9 sessions, never a finding',
  costPerSession: 3000,
  anchor: '/repo/schema.ts',
  remedy: { kind: 'ours', type: 'skeleton-only', anchor: '/repo/schema.ts' },
  ...over,
});

describe('dollars are the same data with three rules attached', () => {
  test('tokens are not priced without a user-configured effective rate', () => {
    expect(dollars(1_000_000)).toBeNull();
  });

  test('the configured rate already represents cache, model, plan, and credits', () => {
    process.env.TOKEN_OPTIMIZER_EFFECTIVE_INPUT_USD_PER_MILLION = '2.25';
    expect(dollars(1_000_000, { kind: 'cacheRead' })).toBeCloseTo(2.25);
    expect(dollars(1_000_000, { kind: 'cacheWrite' })).toBeCloseTo(2.25);
  });

  test('an unmeasured saving has no price, and does not become zero', () => {
    // "$0.00" reads as "saved nothing", which is a different claim entirely --
    // and a wrong number in dollars gets quoted to other people.
    expect(dollars(null)).toBeNull();
    expect(money(null)).toBe('not priced');
    expect(money(0)).toBe('$0.00');
  });

  test('the configured rate is visible rather than hidden in code', () => {
    process.env.TOKEN_OPTIMIZER_EFFECTIVE_INPUT_USD_PER_MILLION = '20';
    expect(dollars(1_000_000)).toBeCloseTo(20);
    expect(priceNote()).toMatch(/configured effective input rate \$20\/M/);
    expect(prices()).toMatchObject({
      source: 'configured-effective-rate',
      effectiveInputUsdPerMillion: 20,
    });
  });

  test('a monthly figure states the assumption it rests on', () => {
    process.env.TOKEN_OPTIMIZER_EFFECTIVE_INPUT_USD_PER_MILLION = '15';
    const out = monthly(3000, { sessionsPerMonth: 60 });
    expect(out.sessionsPerMonth).toBe(60);
    expect(out.amount).toBeCloseTo(dollars(180_000));
  });
});

describe('the queue is ranked, and knows what is already handled', () => {
  test('the most expensive finding comes first', () => {
    const { queue } = buildQueue(dir, [
      finding({ costPerSession: 400, anchor: '/a.ts' }),
      finding({ costPerSession: 9000, anchor: '/b.ts' }),
    ]);
    expect(queue[0].costPerSession).toBe(9000);
  });

  test('a finding whose fix is already in force is dropped, not repeated', () => {
    // Solved is not a problem, and continuing to list it is how a queue becomes
    // a wall of noise.
    const item = finding();
    applyRemedy(dir, item);
    expect(buildQueue(dir, [item]).queue).toHaveLength(0);
  });

  test('applied fixes are reported with what they ACTUALLY saved', () => {
    for (const s of ['s1', 's2', 's3']) read(s, '/repo/schema.ts', 3000);
    const detected =
      detect(dir, null).find((d) => d.id === 'barren-anchor') ||
      finding({ anchor: '/repo/schema.ts' });
    applyRemedy(dir, detected);
    read('s4', '/repo/schema.ts', 100);
    read('s5', '/repo/schema.ts', 100);

    const out = renderAudit(dir, []);
    expect(out.text).toMatch(/Already applied, and what it actually saved/);
    expect(out.text).toMatch(/measured [\d,]+ tokens\/session/);
  });
});

describe('advice declined twice stops being offered', () => {
  test('one decline still shows it', () => {
    const item = finding();
    const { queue } = buildQueue(dir, [item]);
    decline(dir, queue[0].id);
    expect(buildQueue(dir, [item]).queue).toHaveLength(1);
  });

  test('the limit is reached and it is suppressed, with a count', () => {
    // Repeating rejected advice is how a coach becomes a nag, and the second
    // telling is worth less than the tokens it costs.
    const item = finding();
    const id = buildQueue(dir, [item]).queue[0].id;
    for (let i = 0; i < DECLINE_LIMIT; i++) decline(dir, id);

    const out = buildQueue(dir, [item]);
    expect(out.queue).toHaveLength(0);
    expect(out.suppressed[0].times).toBe(DECLINE_LIMIT);
    expect(declines(dir).get(id)).toBe(DECLINE_LIMIT);
  });

  test('suppressed items are still reachable on request', () => {
    const item = finding();
    const id = buildQueue(dir, [item]).queue[0].id;
    for (let i = 0; i < DECLINE_LIMIT; i++) decline(dir, id);
    expect(renderAudit(dir, [item], { full: true }).text).toMatch(
      /declined 2x/
    );
  });
});

describe('it measures whether the advice changed anything', () => {
  test('a habit that improved after being raised is reported as such', () => {
    // A pattern analysis describes behaviour; a before-and-after says whether
    // anything happened.
    for (const s of ['s1', 's2']) read(s, '/repo/schema.ts', 4000);
    raise(dir, finding());
    for (const s of ['s3', 's4']) read(s, '/repo/schema.ts', 500);

    const trend = habitTrend(dir, 'barren-anchor');
    expect(trend.improved).toBe(true);
    expect(trend.before).toBeGreaterThan(trend.after);
  });

  test('a habit that got worse is reported honestly', () => {
    for (const s of ['s1', 's2']) read(s, '/repo/schema.ts', 500);
    raise(dir, finding());
    for (const s of ['s3', 's4']) read(s, '/repo/schema.ts', 4000);
    expect(habitTrend(dir, 'barren-anchor').improved).toBe(false);
  });

  test('too little on either side yields no trend rather than a coin flip', () => {
    read('s1', '/repo/schema.ts', 4000);
    raise(dir, finding());
    read('s2', '/repo/schema.ts', 500);
    expect(habitTrend(dir, 'barren-anchor')).toBeNull();
  });

  test('advice never given has no trend to report', () => {
    expect(habitTrend(dir, 'never-raised')).toBeNull();
  });
});

describe('the audit is held to its own standard', () => {
  test('it states its own cost and what it found', () => {
    // An audit that spends 8,000 tokens describing 6,000 of waste is a net loss.
    const out = renderAudit(dir, [finding()]);
    expect(out.text).toMatch(
      /This report cost about [\d,]+ tokens and names [\d,]+ tokens\/session/
    );
    expect(out.selfCostTokens).toBeGreaterThan(0);
  });

  test('findings worth less than their printing cost are withheld, and counted', () => {
    const items = [
      finding({ costPerSession: 9000, anchor: '/big.ts' }),
      ...Array.from({ length: 6 }, (_, i) =>
        finding({
          costPerSession: 3,
          anchor: `/tiny${i}.ts`,
          title: `tiny finding number ${i} with a fairly long title`,
        })
      ),
    ];
    const out = renderAudit(dir, items);

    expect(out.withheld).toBe(6);
    // Never a silent cap: what was dropped and what it is worth are both stated.
    expect(out.text).toMatch(
      /6 more finding\(s\) worth \d+ tokens\/session in total/
    );
    expect(out.text).toMatch(/full=true/);
  });

  test('full=true prints everything regardless of what it costs', () => {
    const items = Array.from({ length: 6 }, (_, i) =>
      finding({ costPerSession: 3, anchor: `/tiny${i}.ts` })
    );
    expect(renderAudit(dir, items, { full: true }).withheld).toBe(0);
  });

  test('a finding with no measured cost is shown, not treated as worthless', () => {
    // Unpriceable is not worthless. Routing advice and cache attribution before
    // a transcript exists have no number yet, and withholding them on a
    // value-per-token test would be the same "unknown becomes zero" error this
    // project corrects everywhere else.
    const out = renderAudit(dir, [
      finding({ costPerSession: 9000, anchor: '/big.ts' }),
      finding({
        costPerSession: null,
        anchor: '/y',
        remedy: null,
        title: 'multi-file work is routed to a tier that keeps retrying',
      }),
    ]);

    expect(out.withheld).toBe(0);
    expect(out.text).toContain('routed to a tier that keeps retrying');
    expect(out.text).toMatch(/cost not yet measurable/);
    // And no price beside it. "$0.00" next to an unknown cost reads as "this
    // costs nothing", which is a different claim -- and dollars get quoted.
    expect(out.text).not.toMatch(/cost not yet measurable \(~\$0\.00/);
  });

  test('the first finding is always shown, however cheap', () => {
    // Truncating to nothing would make the queue useless on a tidy project.
    expect(renderAudit(dir, [finding({ costPerSession: 1 })]).shown).toBe(1);
  });

  test('an empty audit says so rather than printing a shell', () => {
    expect(renderAudit(dir, []).text).toMatch(/Nothing addressable found/);
  });

  test('every line carries a way to act on it', () => {
    const out = renderAudit(dir, [
      finding(),
      finding({
        anchor: '/x',
        remedy: { kind: 'yours', type: 'edit', file: 'CLAUDE.md' },
        title: 'CLAUDE.md timestamp',
        costPerSession: 5000,
      }),
      finding({
        anchor: '/y',
        remedy: null,
        title: 'session spike',
        costPerSession: 4000,
      }),
    ]);
    expect(out.text).toMatch(/apply: waste_audit/);
    expect(out.text).toMatch(/needs your yes, nothing changed/);
    expect(out.text).toMatch(/advice only -- no automatic fix/);
  });

  test('the price table is printed beside the figures', () => {
    expect(renderAudit(dir, [finding()]).text).toMatch(
      /cost not priced: set TOKEN_OPTIMIZER_EFFECTIVE_INPUT/
    );
  });
});

describe('the report does not misstate its own numbers', () => {
  test('a measured cost of zero is not labelled unmeasurable', () => {
    // The price branch tested `costPerSession == null` while the text branch tested truthiness,
    // so a real 0 rendered "cost not yet measurable (~$0.00/month)" -- the exact contradiction
    // the assertion below already forbids, reachable because waste.mjs defaults every finding
    // to 0 and hard-sets it on the co-occurrence detector.
    const dir = mkdtempSync(join(tmpdir(), 'auditzero-'));
    try {
      const out = renderAudit(
        dir,
        [
          {
            id: 'co-occurrence',
            title: 'a and b are always opened together',
            costPerSession: 0,
          },
        ],
        { full: true }
      );
      expect(out.text).not.toMatch(/cost not yet measurable \(~\$0\.00/);
      expect(out.text).toMatch(/0 tokens\/session/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an advice-only finding prints the id needed to decline it', () => {
    // `decline` keys strictly on the recorded id, which is anchor-derived and unguessable. With
    // the id printed only on the appliable branch, model-routing findings -- which carry no
    // remedy -- could never be suppressed no matter how often a user declined them.
    const dir = mkdtempSync(join(tmpdir(), 'auditid-'));
    try {
      const out = renderAudit(
        dir,
        [
          {
            id: 'model-routing',
            title: 'a cheaper model would do',
            costPerSession: 100,
            remedy: null,
          },
        ],
        { full: true }
      );
      expect(out.text).toMatch(/decline: model-routing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the self-cost includes the closing sentence it reports', () => {
    // Measuring the body before pushing the closing line left the longest line of the report
    // out of its own cost -- biasing, in the tool's favour, the very comparison the figure
    // exists to make honest.
    const dir = mkdtempSync(join(tmpdir(), 'auditself-'));
    try {
      const out = renderAudit(
        dir,
        [
          {
            id: 'x',
            title: 'a finding with a reasonably long title to bulk the body',
            costPerSession: 5000,
          },
        ],
        { full: true }
      );
      const stated = Number(
        /cost about ([\d,]+) tokens/.exec(out.text)[1].replace(/,/g, '')
      );
      const actual = Math.ceil(out.text.length / 4);
      // The stated figure must not undercount the rendered report.
      expect(stated).toBeGreaterThanOrEqual(actual * 0.9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the standing-context panel', () => {
  // WHY THIS IS HERE AT ALL. renderStanding was implemented, tested and called
  // by nothing -- the same shape as forTouch, in the subsystem #203 claimed
  // closed the skills-and-memory gap. These assertions are what make it stay
  // wired: the reachability guard can only tell that SOMETHING references the
  // name, not that the report reaches a reader.
  const verdicts = [
    {
      entry: 'CLAUDE.md',
      tokens: 4200,
      invocations: null,
      termsApplied: 2,
      sessions: 12,
      stale: [{ line: 31, why: 'names a script that no longer exists' }],
      neverUsed: false,
      bloated: true,
      evidence: 'measured',
      actions: [{ action: 'fix', kind: 'yours', why: 'the claim is provably stale' }],
    },
    {
      entry: '.claude/skills/quiet.md',
      tokens: 900,
      invocations: 3,
      termsApplied: null,
      sessions: 12,
      stale: [],
      neverUsed: false,
      bloated: false,
      evidence: 'measured',
      actions: [],
    },
  ];

  test('renders the panel when verdicts are supplied', () => {
    const out = renderAudit(dir, [], { standing: verdicts });
    expect(out.text).toMatch(/Standing context -- charged every session/);
    expect(out.text).toContain('CLAUDE.md');
    expect(out.text).toMatch(/PROVABLY STALE/);
  });

  test('carries the two things the queue cannot say', () => {
    const out = renderAudit(dir, [], { standing: verdicts });
    // The prefix total: no single finding row carries it.
    expect(out.text).toContain('5,100 tokens total');
    // A file with NOTHING wrong produces no finding, so the queue cannot
    // mention it -- and "we looked and it is fine" is the answer that stops
    // this being re-litigated every session.
    expect(out.text).toContain('.claude/skills/quiet.md');
    expect(out.text).toMatch(/nothing to do/);
  });

  test('claims the actions are in the queue ONLY when they are', () => {
    // THIS TEST USED TO REQUIRE THE FALSE CLAIM, which review caught. Rendered
    // with no findings, the queue prints "Nothing addressable found" -- and the
    // panel still told the reader the actions "also appear in the queue at the
    // top". Pointing somebody at a row that is not there is worse than silence.
    const withoutQueue = renderAudit(dir, [], { standing: verdicts });
    expect(withoutQueue.text).toMatch(/Nothing addressable found/);
    expect(withoutQueue.text).not.toMatch(/also appear in the queue/);

    // With the matching standing rows actually in the queue, the pointer is
    // true and worth printing: the panel and the queue would otherwise read as
    // two unrelated lists saying the same thing.
    const withQueue = renderAudit(
      dir,
      [{ id: 'standing-fix', title: 'CLAUDE.md: the claim is provably stale', costPerSession: 4200 }],
      { standing: verdicts, full: true }
    );
    expect(withQueue.text).toMatch(/also appear in the queue/);
  });

  test('omits the panel entirely when there is no standing context', () => {
    // Silence rather than an empty heading: a panel that always prints costs
    // tokens in every audit on a project with no CLAUDE.md.
    // The control: the SAME renderer prints the panel when there IS standing
    // context. Without it, a renderer that produced nothing at all would
    // satisfy every absence below and read as correct silence.
    expect(renderAudit(dir, [], { standing: verdicts }).text).toMatch(
      /Standing context -- charged/
    );

    for (const empty of [null, undefined, []]) {
      const out = renderAudit(dir, [], { standing: empty });
      expect(out.text).not.toMatch(/Standing context -- charged/);
    }
  });

  test('the panel is inside the report self-cost, not outside it', () => {
    // The report exists to prove it is not a net loss. A panel excluded from
    // its own cost figure biases exactly that comparison.
    const bare = renderAudit(dir, [], { standing: null });
    const withPanel = renderAudit(dir, [], { standing: verdicts });
    const stated = (out) =>
      Number(/cost about ([\d,]+) tokens/.exec(out.text)[1].replace(/,/g, ''));
    expect(stated(withPanel)).toBeGreaterThan(stated(bare));
    expect(stated(withPanel)).toBeGreaterThanOrEqual(
      Math.ceil(withPanel.text.length / 4) * 0.9
    );
  });
});

describe('the local derivation metric has a reader', () => {
  test('keeps evidence, candidates, and stored findings distinct in the audit', () => {
    expect(renderAudit(dir, []).text).not.toMatch(/Local derivation:/);

    record(dir, { kind: 'derive', observations: 7, candidates: 3, written: 2 });
    record(dir, { kind: 'derive', observations: 5, candidates: 2, written: 1 });

    expect(renderAudit(dir, []).text).toMatch(
      /Local derivation: 5 candidate\(s\) from 12 observation\(s\); 3 stored across 2 Stop run\(s\)\./
    );
  });
});
