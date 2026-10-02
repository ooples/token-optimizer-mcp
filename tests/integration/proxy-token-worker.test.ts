/**
 * The real counting thread, against the real build.
 *
 * WHY THIS CANNOT BE A UNIT TEST. The worker is addressed as a sibling `.js`
 * file resolved from `import.meta.url`, so under the TypeScript test runner it
 * resolves to a path that does not exist -- the only place the thread can
 * actually be started is `dist`. The unit suite therefore injects a backend and
 * tests the bound, the naming and the bookkeeping; this one tests that a thread
 * starts at all, counts the same text the same way, and lets the process exit.
 *
 * THE LAST OF THOSE IS WHY THIS FILE EXISTS. A bare `unref` on the worker was
 * wrong in a way no unit test could see: a pending promise does not hold the
 * event loop open, so a process whose only outstanding work was a token count
 * exited before the reply arrived and the count never settled. Inside the proxy
 * a listening socket hid it. The "a count outlives nothing else keeping the
 * process alive" test below is the one that caught it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULE = join(ROOT, 'dist', 'proxy', 'token-accounting.js');
const WORKER = join(ROOT, 'dist', 'proxy', 'token-accounting-worker.js');
const PROXY = pathToFileURL(join(ROOT, 'dist', 'proxy', 'server.js')).href;

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(
      newest,
      entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs
    );
  }
  return newest;
}

/**
 * Runs a snippet in a FRESH node process with the built module imported.
 *
 * A fresh process per case is the point: this suite is partly about whether the
 * process can exit, which is not observable inside a runner that is holding it
 * open for its own reasons.
 */
function inFreshProcess(snippet: string): string {
  return execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        `const m = await import(${JSON.stringify(pathToFileURL(MODULE).href)});`,
        snippet,
      ].join('\n'),
    ],
    { encoding: 'utf8', timeout: 60_000 }
  ).trim();
}

describe('proxy token accounting worker (built)', () => {
  beforeAll(() => {
    if (!existsSync(MODULE) || !existsSync(WORKER)) {
      throw new Error(
        `${WORKER} is missing -- run \`npm run build\` before the integration suite`
      );
    }
    // A STALE dist passes for the wrong reason: it would run the previous
    // build's worker and report green over a fix that had been written but not
    // compiled.
    const built = Math.min(statSync(MODULE).mtimeMs, statSync(WORKER).mtimeMs);
    if (newestMtime(join(ROOT, 'src')) > built) {
      throw new Error(
        `dist/proxy is older than src/ -- run \`npm run build\`, or this suite ` +
          `tests the previous build`
      );
    }
  });

  it('starts a thread and counts both sides', () => {
    const out = inFreshProcess(`
      const a = m.createTokenAccounting();
      const r = await a.countPair('the quick brown fox jumps over the lazy dog', 'the quick brown fox');
      console.log(JSON.stringify(r));
      await a.shutdown();
    `);

    const result = JSON.parse(out);
    expect(result.measured).toBe(true);
    expect(result.method).toBe('tiktoken-gpt-4-compatible-local-estimate');
    // Real tiktoken figures, not word counts: the before side is the longer
    // text and both are plausible token counts for it.
    expect(result.beforeTokens).toBeGreaterThan(result.afterTokens);
    expect(result.beforeTokens).toBeGreaterThan(5);
    expect(result.beforeTokens).toBeLessThan(20);
  });

  it('settles a count whose process has nothing else keeping it alive', () => {
    // THE REGRESSION THIS PINS. With the worker left permanently unref'd, this
    // process printed nothing and exited 0 -- a silently unsettled promise,
    // which in the proxy would mean a ledger row that never arrives.
    const out = inFreshProcess(`
      const a = m.createTokenAccounting();
      a.countPair('alpha beta gamma delta', 'alpha').then((r) => {
        console.log('settled ' + r.measured + ' ' + r.beforeTokens);
      });
    `);

    expect(out).toMatch(/^settled true \d+$/);
  });

  it('lets the process exit once counting is done', () => {
    // The other half of the same property: holding the reference while work is
    // outstanding must not turn into holding it forever. A hang here would
    // surface as the 60s timeout on execFileSync, so reaching the assertion is
    // itself the measurement.
    const started = Date.now();
    const out = inFreshProcess(`
      const a = m.createTokenAccounting();
      await a.countPair('one two', 'one');
      console.log('done');
    `);

    expect(out).toBe('done');
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it('counts the prompt a deferred request becomes, not the body it sent', () => {
    // THE DEFAULT CONFIGURATION, MEASURED WRONG. Tool deferral marks schemas
    // `defer_loading: true` and prepends a search tool, so the request GROWS on
    // the wire while the prompt the provider assembles from it loses most of
    // its size. Counting the wire therefore filed the largest saving the proxy
    // makes as an expansion debit -- measured at -194 tokens on a 40-tool
    // request whose prompt-level saving is +6284 -- and this is the only place
    // it can be seen, because it is a claim about which BODY was counted and
    // the unit suites have no counter to ask.
    const out = inFreshProcess(`
      const http = await import('node:http');
      const fs = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      const { startProxy } = await import(${JSON.stringify(PROXY)});

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-defer-'));
      const ledger = path.join(dir, 'ledger.jsonl');
      process.env.TOKEN_OPTIMIZER_PROXY_ACCOUNTING = ledger;

      const upstream = http.createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ usage: { input_tokens: 941, output_tokens: 2 } }));
        });
      });
      await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
      const proxy = await startProxy({
        port: 0,
        upstream: 'http://127.0.0.1:' + upstream.address().port,
        knowledge: false,
      });
      // VERBOSE SCHEMAS, because deferral only defers what is worth deferring
      // and a request of forty one-line tools is not a request anyone sends.
      const tools = Array.from({ length: 40 }, (unused, i) => ({
        name: 'tool_' + i,
        description:
          'Operates on resource ' + i + '. Takes a path and a mode and reports ' +
          'what it did, at some length, because a real tool schema is prose.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The file to operate on.' },
            mode: { type: 'string', description: 'One of read, write, append.' },
          },
          required: ['path'],
        },
      }));
      const body = JSON.stringify({
        model: 'claude-opus-4-20250514',
        messages: [{ role: 'user', content: 'rename the handler in server.ts' }],
        tools,
      });
      const res = await fetch('http://127.0.0.1:' + proxy.server.address().port + '/v1/messages', {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json' },
      });
      await res.text();
      for (let i = 0; i < 200 && !fs.existsSync(ledger); i += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => proxy.server.close(r));
      await new Promise((r) => upstream.close(r));
      // ONE REQUEST, ONE ROW, so the whole file is the row and nothing has to
      // be split out of it.
      console.log(fs.readFileSync(ledger, 'utf8').trim());
      fs.rmSync(dir, { recursive: true, force: true });
    `);

    const row = JSON.parse(out);
    expect(row.deferredTools).toBeGreaterThan(0);
    // THE WIRE WENT THE OTHER WAY, in the row's own bytes: we sent more than we
    // were given. This is the control that makes the counts below a finding
    // rather than a coincidence -- there is no positive wire delta to read.
    expect(row.afterBytes).toBeGreaterThan(row.beforeBytes);
    expect(row.tokens.measured).toBe(true);
    expect(row.tokens.afterTokens).toBeLessThan(row.tokens.beforeTokens / 2);
    // AND THE CLASS IT LANDS IN. A debit here is the defect, not a near miss.
    expect(row.tokens.afterTokens).toBeLessThan(row.tokens.beforeTokens);
  });

  it('carries the deferral holdout arm onto the ledger row', () => {
    // THE RECURRING DEFECT IN THIS PACKAGE IS A CAPABILITY THAT IS GREEN AND
    // UNREACHED. The arm label is the whole holdout: without it on the row, the
    // estimator has rows and no arms and reports nothing, which looks exactly
    // like an experiment that found no effect. And it must appear on the
    // CONTROL arm above all, because the control arm is made of requests the
    // feature deliberately did nothing to -- a label written only where the
    // feature acted is a trial with one arm in it.
    const out = inFreshProcess(`
      const http = await import('node:http');
      const fs = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      const { startProxy } = await import(${JSON.stringify(PROXY)});

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-arm-'));
      const ledger = path.join(dir, 'ledger.jsonl');
      process.env.TOKEN_OPTIMIZER_PROXY_ACCOUNTING = ledger;
      // EVERY CONVERSATION WITHHELD, so one request is enough to prove the
      // control arm is labelled and left alone.
      process.env.TOKEN_OPTIMIZER_PROXY_DEFER_HOLDOUT = '1';

      const seen = [];
      const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          seen.push(Buffer.concat(chunks).toString('utf8'));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ usage: { input_tokens: 7228, output_tokens: 2 } }));
        });
      });
      await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
      const proxy = await startProxy({
        port: 0,
        upstream: 'http://127.0.0.1:' + upstream.address().port,
        knowledge: false,
      });
      const tools = Array.from({ length: 40 }, (unused, i) => ({
        name: 'tool_' + i,
        description:
          'Operates on resource ' + i + '. Takes a path and a mode and reports ' +
          'what it did, at some length, because a real tool schema is prose.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The file to operate on.' },
            mode: { type: 'string', description: 'One of read, write, append.' },
          },
          required: ['path'],
        },
      }));
      const body = JSON.stringify({
        model: 'claude-opus-4-20250514',
        messages: [{ role: 'user', content: 'rename the handler in server.ts' }],
        tools,
      });
      const res = await fetch('http://127.0.0.1:' + proxy.server.address().port + '/v1/messages', {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json' },
      });
      await res.text();
      for (let i = 0; i < 200 && !fs.existsSync(ledger); i += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => proxy.server.close(r));
      await new Promise((r) => upstream.close(r));
      // ONE OBJECT, ONE LINE: the row plus what the upstream was actually sent,
      // so the arm and the bytes it describes are checked against each other.
      console.log(JSON.stringify({
        row: JSON.parse(fs.readFileSync(ledger, 'utf8').trim()),
        markers: (seen[0].match(/defer_loading/g) ?? []).length,
      }));
      fs.rmSync(dir, { recursive: true, force: true });
    `);

    const { row, markers } = JSON.parse(out);
    expect(row.deferralArm).toBe('control');
    // WITHHELD, AND THE WIRE AGREES. Nothing was marked, so the provider was
    // billed for every schema -- which is what makes this arm the comparison.
    expect(markers).toBe(0);
    expect(row.deferredTools ?? 0).toBe(0);
    // THE PROVIDER'S PROMPT COUNT IS ON THE SAME ROW AS THE ARM, which is the
    // one thing the estimator cannot work around: a label without a billed
    // prompt figure beside it contributes nothing.
    expect(row.usage.input_tokens).toBe(7228);
  });

  it('puts measured token counts on the proxy ledger row', () => {
    // THE WHOLE WIRE, END TO END. The unit suites inject a backend and so can
    // never see the thread; the proxy suites run from TypeScript, where the
    // worker's sibling `.js` does not exist and every count is honestly
    // refused. This is the only place that proves a real proxied request
    // produces a real token figure in the ledger -- which was the entire gap:
    // the proxy saved the most and reported it in bytes, never in the unit a
    // bill is denominated in.
    const out = inFreshProcess(`
      const http = await import('node:http');
      const fs = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      const { startProxy } = await import(${JSON.stringify(PROXY)});

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-tokens-'));
      const ledger = path.join(dir, 'ledger.jsonl');
      process.env.TOKEN_OPTIMIZER_PROXY_ACCOUNTING = ledger;

      const upstream = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ usage: { input_tokens: 100, output_tokens: 2 } }));
      });
      await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
      const proxy = await startProxy({
        port: 0,
        upstream: 'http://127.0.0.1:' + upstream.address().port,
      });
      const body = JSON.stringify({
        messages: [{ role: 'user', content: 'the quick brown fox '.repeat(400) }],
      });
      const res = await fetch('http://127.0.0.1:' + proxy.server.address().port + '/v1/messages', {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json' },
      });
      await res.text();
      // THE ROW MAY LAND AFTER THE RESPONSE, and against a loopback upstream it
      // always does: the round trip here is a millisecond and the count is
      // not. On a real provider the round trip is the longer of the two and the
      // row is written synchronously -- the proxy never makes a request wait
      // for its own measurement, so a reader of the ledger waits instead.
      for (let i = 0; i < 200 && !fs.existsSync(ledger); i += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => proxy.server.close(r));
      await new Promise((r) => upstream.close(r));
      console.log(fs.readFileSync(ledger, 'utf8').trim().split('\\n').pop());
      fs.rmSync(dir, { recursive: true, force: true });
    `);

    const record = JSON.parse(out);
    expect(record.tokens.measured).toBe(true);
    expect(record.tokens.method).toBe(
      'tiktoken-gpt-4-compatible-local-estimate'
    );
    // The bytes were already recorded and are the wrong unit; these are the
    // same request counted in the unit the provider charges in.
    expect(record.beforeBytes).toBeGreaterThan(0);
    expect(record.tokens.beforeTokens).toBeGreaterThan(0);
    expect(record.tokens.afterTokens).toBeGreaterThan(0);
    // OUR COUNT OF THE BODY WE SENT, AGAINST THE PROVIDER'S COUNT OF THE SAME
    // BODY. This is the calibration every request supplies for free -- the
    // stub bills a flat 100, so the check here is only that both numbers are
    // present and separate, which is what makes the comparison possible at all.
    expect(record.usage.input_tokens).toBe(100);
    expect(record.tokens.afterTokens).not.toBe(record.usage.input_tokens);
  });
});
