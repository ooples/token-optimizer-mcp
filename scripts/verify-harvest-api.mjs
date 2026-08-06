#!/usr/bin/env node
/**
 * Exercises the harvest HTTP path against a local server impersonating the
 * Anthropic Messages API.
 *
 * WHAT THIS DOES AND DOES NOT PROVE. It proves OUR side end to end: that the
 * request we send is well formed, that the response shapes a real model
 * actually returns are parsed correctly, and that every failure mode degrades
 * to an empty harvest rather than an exception or a wedged session. It does NOT
 * prove Anthropic accepts the request -- only a live key can do that, and this
 * script does not pretend otherwise.
 *
 * That distinction matters because the code is written to swallow every error
 * and return []. A broken request would look exactly like a quiet session, so
 * without asserting the request CONTENT the harvest could be silently dead in
 * production and nothing would ever say so.
 *
 * Run: npm run verify:harvest
 */

import { createServer } from 'node:http';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
};

/** Set by each scenario to control what the fake API does. */
let handler = () => ({ status: 200, body: { content: [{ type: 'text', text: '[]' }] } });
let lastRequest = null;

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', async () => {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* record it as unparseable */ }
    lastRequest = { method: req.method, headers: req.headers, body: parsed, raw };

    const response = await handler(lastRequest);
    if (response.hang) return; // never answer: exercises the timeout path
    res.writeHead(response.status, { 'content-type': 'application/json' });
    res.end(typeof response.body === 'string' ? response.body : JSON.stringify(response.body));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT = `http://127.0.0.1:${port}/v1/messages`;
process.env.TOKEN_OPTIMIZER_API_KEY = 'sk-ant-test-not-a-real-key';

const { extract, validate, buildDigest } = await import('../hooks-core/harvest.mjs');

const DIGEST = '## User asked\nfix the auth bug\n\n## Files touched\n/src/auth.ts';

try {
  /* ---- The request we send ------------------------------------------- */

  handler = () => ({ status: 200, body: { content: [{ type: 'text', text: '[]' }] } });
  await extract(DIGEST);

  check('POSTs to the messages endpoint', lastRequest?.method === 'POST');
  check('sends the API key header', lastRequest?.headers['x-api-key'] === 'sk-ant-test-not-a-real-key');
  // Omitting this header is a 400 from the real API, and the error would be
  // swallowed into an empty harvest with no clue as to why.
  check('sends anthropic-version', lastRequest?.headers['anthropic-version'] === '2023-06-01');
  check('sends JSON content-type', /application\/json/.test(lastRequest?.headers['content-type'] || ''));
  check('names a real model id', /^claude-/.test(lastRequest?.body?.model || ''), lastRequest?.body?.model);
  check('bounds max_tokens', Number(lastRequest?.body?.max_tokens) > 0);
  check('puts the schema in the system prompt', /anchors/.test(lastRequest?.body?.system || ''));
  check('sends the digest as the user message',
    lastRequest?.body?.messages?.[0]?.content === DIGEST);
  check('sends exactly one message', lastRequest?.body?.messages?.length === 1);

  /* ---- Responses a real model actually returns ------------------------ */

  const finding = { type: 'failure', claim: 'the retry loop deadlocks on close', confidence: 0.8, anchors: ['/src/auth.ts'] };

  handler = () => ({ status: 200, body: { content: [{ type: 'text', text: JSON.stringify([finding]) }] } });
  let out = await extract(DIGEST);
  check('parses a clean JSON array', validate(out).length === 1);

  // Models wrap JSON in prose and fences constantly. Insisting the whole
  // response parse would drop most real harvests on the floor.
  handler = () => ({ status: 200, body: { content: [{ type: 'text',
    text: `Here are the findings I extracted:\n\n\`\`\`json\n${JSON.stringify([finding])}\n\`\`\`\n\nLet me know if you need more.` }] } });
  out = await extract(DIGEST);
  check('parses JSON wrapped in prose and fences', validate(out).length === 1);

  handler = () => ({ status: 200, body: { content: [
    { type: 'thinking', thinking: 'considering...' },
    { type: 'text', text: JSON.stringify([finding]) },
  ] } });
  out = await extract(DIGEST);
  check('ignores non-text blocks', validate(out).length === 1);

  handler = () => ({ status: 200, body: { content: [{ type: 'text', text: '[]' }] } });
  check('an empty extraction is an empty array', (await extract(DIGEST)).length === 0);

  /* ---- Every failure degrades, none throws ---------------------------- */

  handler = () => ({ status: 401, body: { error: { message: 'invalid x-api-key' } } });
  check('401 degrades to empty', (await extract(DIGEST)).length === 0);

  handler = () => ({ status: 429, body: { error: { message: 'rate limited' } } });
  check('429 degrades to empty', (await extract(DIGEST)).length === 0);

  handler = () => ({ status: 500, body: { error: { message: 'overloaded' } } });
  check('500 degrades to empty', (await extract(DIGEST)).length === 0);

  handler = () => ({ status: 200, body: 'this is not json at all' });
  check('a non-JSON body degrades to empty', (await extract(DIGEST)).length === 0);

  handler = () => ({ status: 200, body: { content: [{ type: 'text', text: 'I could not find any findings.' }] } });
  check('prose with no array degrades to empty', (await extract(DIGEST)).length === 0);

  handler = () => ({ status: 200, body: { content: [{ type: 'text', text: '[{"type":"finding", BROKEN' }] } });
  check('malformed JSON degrades to empty', (await extract(DIGEST)).length === 0);

  // A hung endpoint must not hold the session open. This is the failure most
  // likely to be noticed by a user, because it stalls rather than no-ops.
  handler = () => ({ hang: true });
  const started = Date.now();
  const timedOut = await extract(DIGEST, { timeoutMs: 700 });
  const elapsed = Date.now() - started;
  check('a hung endpoint times out and degrades', timedOut.length === 0 && elapsed < 3000, `${elapsed}ms`);

  /* ---- The schema still gates what the model returns ------------------ */

  handler = () => ({ status: 200, body: { content: [{ type: 'text', text: JSON.stringify([
    { type: 'finding', claim: 'no anchor on this one at all', confidence: 0.9, anchors: [] },
    { type: 'musing', claim: 'wrong type entirely here', confidence: 0.9, anchors: ['/src/auth.ts'] },
    { type: 'finding', claim: 'x', confidence: 0.9, anchors: ['/src/auth.ts'] },
    { type: 'finding', claim: 'confidence out of range here', confidence: 9, anchors: ['/src/auth.ts'] },
    finding,
  ]) }] } });
  const gated = validate(await extract(DIGEST));
  check('the schema rejects everything invalid the model returned', gated.length === 1, `${gated.length} accepted`);

  const withKnown = validate(await extract(DIGEST), { knownFiles: new Set(['/other.ts']) });
  check('anchors are held against the real file list', withKnown.length === 0);

  /* ---- What a missing key does, per endpoint -------------------------- */

  // BOTH HALVES, because the answer depends on WHERE the request would go.
  // This check used to assert 'no key means no request' unconditionally, which
  // predates the local-endpoint path: a request to localhost costs nothing and
  // discloses nothing, so it deliberately needs neither a key nor an opt-in.
  // The endpoint here IS local (127.0.0.1 stub), so the old assertion failed --
  // and, being unwired from CI, failed unnoticed.

  delete process.env.TOKEN_OPTIMIZER_API_KEY;
  lastRequest = null;
  const unkeyedLocal = await extract(DIGEST);
  check('a LOCAL endpoint needs no key', lastRequest !== null && unkeyedLocal.length > 0);

  // Remote is the case the original assertion was really protecting: spending
  // money and sending a digest off the machine must never happen unkeyed.
  const localEndpoint = process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT;
  process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT = 'https://api.anthropic.com/v1/messages';
  lastRequest = null;
  const unkeyedRemote = await extract(DIGEST);
  check(
    'a REMOTE endpoint without a key makes NO request',
    lastRequest === null && unkeyedRemote.length === 0
  );

  process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT = localEndpoint;
  process.env.TOKEN_OPTIMIZER_API_KEY = 'sk-ant-test-not-a-real-key';

  /* ---- The privacy claim, on a realistic transcript -------------------- */

  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'harvest-'));
  const transcript = join(dir, 't.jsonl');

  writeFileSync(transcript, [
    JSON.stringify({ message: { role: 'user', content: 'why is login failing?' } }),
    JSON.stringify({ message: { role: 'assistant', content: [
      { type: 'text', text: 'The token check is inverted.' },
      { type: 'tool_use', input: { file_path: '/src/auth.ts' } },
      { type: 'tool_use', input: { command: 'npm test' } },
    ] } }),
    JSON.stringify({ message: { role: 'user', content: [
      { type: 'tool_result', content: 'const STRIPE_SECRET = "sk_live_51H8xQ2";\nconst dbPassword = "hunter2";' },
    ] } }),
  ].join('\n'));

  const digest = buildDigest(transcript);
  lastRequest = null;
  handler = () => ({ status: 200, body: { content: [{ type: 'text', text: '[]' }] } });
  await extract(digest);
  const sent = lastRequest.raw;

  // The whole default rests on this: what crosses the wire must not contain
  // anything that came out of a tool result.
  check('no secret from a tool result crosses the wire', !/sk_live_51H8xQ2/.test(sent));
  check('no password from a tool result crosses the wire', !/hunter2/.test(sent));
  check('the file path and conclusion DO cross', /auth\.ts/.test(sent) && /token check is inverted/.test(sent));

  rmSync(dir, { recursive: true, force: true });
} finally {
  server.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log('NOTE: verifies our side of the contract. Acceptance by the real API needs a live key.');
process.exit(failed.length ? 1 : 0);
