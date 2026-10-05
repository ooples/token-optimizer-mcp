import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import {
  SmartSecurity,
  runSmartSecurity,
} from '../../../src/tools/code-analysis/smart-security.js';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';

/**
 * THE SAME SIX FINDINGS, STATED THREE TIMES.
 *
 * Measured on the benched fixture, which is one file with six findings in it:
 * the reply came to 697 tokens against a 486-token file, a 43% loss, and 303 of
 * those tokens were restatement. `Findings by Category` recounted the section
 * above it -- arithmetic over lines the reader had already been charged for --
 * and listed "Most affected files" as the single file the caller had named.
 * `Remediation Priorities` then gave each category two lines of canned prose
 * keyed on the category alone, next to per-finding `Fix:` lines that said the
 * same thing at a grain that can be acted on. A further 60 tokens went on
 * reprinting that one file's path once per finding.
 *
 * It was also WRONG where it restated: the impact clause summed critical and
 * high, so a category holding only medium findings announced itself as empty --
 * `0 cryptographic weaknesses` two sections below a medium crypto finding.
 *
 * Both halves of this have to hold together. Cheaper alone is satisfied by
 * dropping findings, and complete alone is satisfied by changing nothing, so
 * every count assertion below sits beside one that names what survived. The
 * multi-file cases are the control arm: the single-file shape is a special
 * case, and without them a version that had lost the general branch entirely
 * would pass every assertion about the fixture this was measured on.
 */
describe('a security reply states each thing once', () => {
  let root: string;
  let cacheDirWas: string | undefined;

  /*
   * THE FIXTURE THE MEASUREMENT WAS TAKEN ON, not a reconstruction of it.
   *
   * A first draft of this file used five hand-written lines holding the same
   * six findings, and the cost assertion below failed on it -- correctly. Six
   * findings with a remediation each cannot be cheaper than a 69-token file,
   * and nothing is wrong with the tool when they are not: a per-finding report
   * beats reading the code only once the code is bigger than the report. The
   * benched fixture is 486 tokens, which is the size the 43% loss and the
   * saving that replaced it were both measured at, so it is what is read here.
   *
   * Structural assertions, not counted ones, so editing that fixture moves the
   * numbers here without silently inverting what is being claimed.
   */
  const FIXTURE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'bench',
    'tools',
    'fixtures',
    'insecure-handlers.ts'
  );
  const SIX = readFileSync(FIXTURE, 'utf8');

  const text = (options: Record<string, unknown>) =>
    runSmartSecurity({ force: true, projectRoot: root, ...options });

  function structured(options: Record<string, unknown>) {
    // A CACHE PER CALL, NEVER THE REAL HOME.
    const tool = new SmartSecurity(
      new CacheEngine(mkdtempSync(join(tmpdir(), 'sec-once-cache-')), 100),
      new TokenCounter(),
      new MetricsCollector(),
      root
    );
    return tool
      .run({ force: true, projectRoot: root, ...options })
      .finally(() => tool.close());
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'security-once-'));
    // `runSmartSecurity` builds its own CacheEngine under the real home, and
    // the text cases below call it.
    cacheDirWas = process.env.TOKEN_OPTIMIZER_CACHE_DIR;
    process.env.TOKEN_OPTIMIZER_CACHE_DIR = mkdtempSync(
      join(tmpdir(), 'sec-once-cli-')
    );
    writeFileSync(join(root, 'handlers.ts'), SIX);
  });

  afterEach(() => {
    if (cacheDirWas === undefined) delete process.env.TOKEN_OPTIMIZER_CACHE_DIR;
    else process.env.TOKEN_OPTIMIZER_CACHE_DIR = cacheDirWas;
    rmSync(root, { recursive: true, force: true });
  });

  describe('on a scan of one file', () => {
    it('names the file once, not once per finding', async () => {
      const out = await text({ targets: ['handlers.ts'] });

      expect(out.split('handlers.ts').length - 1).toBe(1);
      // AND THE FINDINGS ARE STILL THERE, each with the line and column that
      // the path used to be glued to. Without this the assertion above is
      // satisfied by a reply that found nothing.
      expect(out).toMatch(/Findings by Severity:/);
      expect(out).toMatch(/\[unsafe-eval\]/);
      expect(out).toMatch(/^\s+\d+:\d+ \[/m);
    });

    it('leaves out the category regrouping, which recounts the findings', async () => {
      const out = await text({ targets: ['handlers.ts'] });

      expect(out).not.toMatch(/Findings by Category:/);
      expect(out).not.toMatch(/Most affected files/);
      // The categories themselves are not gone -- they are on each finding.
      expect(out).toMatch(/\[crypto\]/);
    });

    it('ranks the remediations on one line each, without the canned prose', async () => {
      const out = await text({ targets: ['handlers.ts'] });

      // The ranking is the part the severity listing does not carry.
      expect(out).toMatch(/Remediation Priorities:/);
      expect(out).toMatch(/^ {2}\[\d+\] \S+ x\d+ -- \S/m);
      expect(out).not.toMatch(/^\s+Impact:/m);
      expect(out).not.toMatch(/^\s+Action:/m);
    });

    it('costs less than the file it scanned', async () => {
      // THE WHOLE CLAIM, MEASURED THE WAY THE BENCH MEASURES IT: the reply as
      // sent against the file a caller would otherwise have read, by one
      // counter. This was a 43% loss on the benched fixture.
      const counter = new TokenCounter();
      const out = await text({ targets: ['handlers.ts'] });

      expect(counter.count(out).tokens).toBeLessThan(counter.count(SIX).tokens);
    });
  });

  describe('on a scan of more than one file', () => {
    beforeEach(() => {
      writeFileSync(
        join(root, 'second.ts'),
        'export const e = (s) => eval(s);'
      );
    });

    it('still names every file, because the path is doing work there', async () => {
      const out = await text({});

      expect(out).toMatch(/handlers\.ts/);
      expect(out).toMatch(/second\.ts/);
      // The single-file header is a special case and must not have replaced
      // the general branch.
      expect(out).not.toMatch(/^ {2}in .*handlers\.ts$/m);
    });

    it('keeps the category regrouping, which now names where findings sit', async () => {
      const out = await text({});

      expect(out).toMatch(/Findings by Category:/);
      expect(out).toMatch(/^\s+in .*\.ts/m);
    });
  });

  describe('the impact a category reports', () => {
    it('counts a category whose findings are all medium', async () => {
      // `Math.random()` is the medium crypto finding. The clause summed
      // critical and high, so this read `0 cryptographic weaknesses`.
      const out = await structured({ targets: ['handlers.ts'] });
      const crypto = out.remediationPriorities.find(
        (p) => p.category === 'crypto'
      );

      expect(crypto).toBeDefined();
      expect(crypto?.count).toBeGreaterThan(0);
      expect(crypto?.impact).toMatch(
        new RegExp('^' + String(crypto?.count) + ' ')
      );
      expect(crypto?.impact).not.toMatch(/^0 /);
    });

    it('still counts a category whose findings are critical', async () => {
      // THE CONTROL ARM. Passing the wrong number is only visible against a
      // category where the old arithmetic happened to be right.
      const out = await structured({ targets: ['handlers.ts'] });
      const injection = out.remediationPriorities.find(
        (p) => p.category === 'injection'
      );

      expect(injection).toBeDefined();
      expect(injection?.impact).toMatch(
        new RegExp('^' + String(injection?.count) + ' ')
      );
    });
  });
});
