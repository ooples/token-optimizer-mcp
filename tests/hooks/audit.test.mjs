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
  buildQueue, renderAudit, decline, declines, habitTrend, raise, DECLINE_LIMIT,
} from '../../hooks-core/audit.mjs';
import { applyRemedy } from '../../hooks-core/remedy.mjs';
import { dollars, money, monthly, prices, priceNote } from '../../hooks-core/pricing.mjs';
import { detect } from '../../hooks-core/waste.mjs';

let workspace;
let dir;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'audit-'));
  dir = join(workspace, '.token-optimizer', 'wiki');
  delete process.env.TOKEN_OPTIMIZER_PRICES;
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  delete process.env.TOKEN_OPTIMIZER_PRICES;
});

const read = (sessionId, anchor, tokens) => recordRead(dir, { sessionId, anchor, bytes: tokens * 4 });

const finding = (over) => ({
  id: 'barren-anchor', title: 'schema.ts: read in 9 sessions, never a finding',
  costPerSession: 3000, anchor: '/repo/schema.ts',
  remedy: { kind: 'ours', type: 'skeleton-only', anchor: '/repo/schema.ts' },
  ...over,
});

describe('dollars are the same data with three rules attached', () => {
  test('tokens convert at the published rate for the tier', () => {
    expect(dollars(1_000_000, { tier: 'opus' })).toBeCloseTo(15);
    expect(dollars(1_000_000, { tier: 'haiku' })).toBeCloseTo(1);
  });

  test('cache reads and writes carry their own multipliers', () => {
    expect(dollars(1_000_000, { tier: 'opus', kind: 'cacheRead' })).toBeCloseTo(1.5);
    expect(dollars(1_000_000, { tier: 'opus', kind: 'cacheWrite' })).toBeCloseTo(18.75);
  });

  test('an unmeasured saving has no price, and does not become zero', () => {
    // "$0.00" reads as "saved nothing", which is a different claim entirely --
    // and a wrong number in dollars gets quoted to other people.
    expect(dollars(null)).toBeNull();
    expect(money(null)).toBe('not yet measurable');
    expect(money(0)).toBe('$0.00');
  });

  test('the table is overridable, so a stale rate is visible rather than silent', () => {
    process.env.TOKEN_OPTIMIZER_PRICES = JSON.stringify({ asOf: '2027-01', opus: { input: 20, output: 100 } });
    expect(dollars(1_000_000, { tier: 'opus' })).toBeCloseTo(20);
    expect(priceNote('opus')).toMatch(/2027-01, overridden/);
  });

  test('an unparseable override is ignored rather than fatal', () => {
    process.env.TOKEN_OPTIMIZER_PRICES = 'not json';
    expect(prices().asOf).toBeTruthy();
  });

  test('a monthly figure states the assumption it rests on', () => {
    const out = monthly(3000, { tier: 'opus', sessionsPerMonth: 60 });
    expect(out.sessionsPerMonth).toBe(60);
    expect(out.amount).toBeCloseTo(dollars(180_000, { tier: 'opus' }));
  });
});

describe('the queue is ranked, and knows what is already handled', () => {
  test('the most expensive finding comes first', () => {
    const { queue } = buildQueue(dir, [finding({ costPerSession: 400, anchor: '/a.ts' }), finding({ costPerSession: 9000, anchor: '/b.ts' })]);
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
    const detected = detect(dir, null).find((d) => d.id === 'barren-anchor')
      || finding({ anchor: '/repo/schema.ts' });
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
    expect(renderAudit(dir, [item], { full: true }).text).toMatch(/declined 2x/);
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
    expect(out.text).toMatch(/This report cost about [\d,]+ tokens and names [\d,]+ tokens\/session/);
    expect(out.selfCostTokens).toBeGreaterThan(0);
  });

  test('findings worth less than their printing cost are withheld, and counted', () => {
    const items = [
      finding({ costPerSession: 9000, anchor: '/big.ts' }),
      ...Array.from({ length: 6 }, (_, i) => finding({ costPerSession: 3, anchor: `/tiny${i}.ts`, title: `tiny finding number ${i} with a fairly long title` })),
    ];
    const out = renderAudit(dir, items);

    expect(out.withheld).toBe(6);
    // Never a silent cap: what was dropped and what it is worth are both stated.
    expect(out.text).toMatch(/6 more finding\(s\) worth \d+ tokens\/session in total/);
    expect(out.text).toMatch(/full=true/);
  });

  test('full=true prints everything regardless of what it costs', () => {
    const items = Array.from({ length: 6 }, (_, i) => finding({ costPerSession: 3, anchor: `/tiny${i}.ts` }));
    expect(renderAudit(dir, items, { full: true }).withheld).toBe(0);
  });

  test('a finding with no measured cost is shown, not treated as worthless', () => {
    // Unpriceable is not worthless. Routing advice and cache attribution before
    // a transcript exists have no number yet, and withholding them on a
    // value-per-token test would be the same "unknown becomes zero" error this
    // project corrects everywhere else.
    const out = renderAudit(dir, [
      finding({ costPerSession: 9000, anchor: '/big.ts' }),
      finding({ costPerSession: null, anchor: '/y', remedy: null, title: 'multi-file work is routed to a tier that keeps retrying' }),
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
      finding({ anchor: '/x', remedy: { kind: 'yours', type: 'edit', file: 'CLAUDE.md' }, title: 'CLAUDE.md timestamp', costPerSession: 5000 }),
      finding({ anchor: '/y', remedy: null, title: 'session spike', costPerSession: 4000 }),
    ]);
    expect(out.text).toMatch(/apply: waste_audit/);
    expect(out.text).toMatch(/needs your yes, nothing changed/);
    expect(out.text).toMatch(/advice only -- no automatic fix/);
  });

  test('the price table is printed beside the figures', () => {
    expect(renderAudit(dir, [finding()]).text).toMatch(/prices: opus \$15\/\$75 per Mtok/);
  });
});
