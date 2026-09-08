/**
 * The advertised local-model path has to actually work.
 *
 * Both the SessionStart notice and `doctor` tell the user to point
 * TOKEN_OPTIMIZER_HARVEST_ENDPOINT at a local model. The client only ever spoke
 * the Anthropic Messages dialect -- `system` as a top-level field, `content[]`
 * blocks in the reply -- while ollama, LM Studio and llama.cpp all serve
 * OpenAI-compatible /v1/chat/completions, which takes the system prompt as a
 * message and answers with `choices[].message.content`.
 *
 * Measured before the fix, against a stand-in server answering both dialects
 * with the identical finding: the Anthropic path returned 1 and the OpenAI path
 * returned 0. Silently -- `if (!response.ok) return []` made a misconfigured
 * endpoint indistinguishable from a session with nothing to learn, which is how
 * this stayed invisible while the graph accumulated 3 harvested findings ever.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { createServer } from 'node:http';

import { extract, harvestFailure, endpointDialect } from '../../hooks-core/harvest.mjs';

const FINDING = [
  {
    type: 'command',
    claim: 'the stand-in model answered',
    evidence: 'returned by the test server',
    applicability: 'while proving the harvest transport works',
    confidenceLabel: 'verified',
    anchors: ['hooks-core/harvest.mjs'],
  },
];

let server;
let port;
let seen;
let saved;

/** Answers in whichever dialect the path asks for, and records the request. */
const start = ({ status = 200, shape = 'auto' } = {}) =>
  new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        seen = { url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
        if (status !== 200) {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        const text = JSON.stringify(FINDING);
        const openai = shape === 'openai' || (shape === 'auto' && req.url.includes('chat/completions'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            openai
              ? { choices: [{ message: { role: 'assistant', content: text } }] }
              : { content: [{ type: 'text', text }] }
          )
        );
      });
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });

beforeEach(() => {
  seen = null;
  saved = {
    endpoint: process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT,
    key: process.env.TOKEN_OPTIMIZER_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    mode: process.env.TOKEN_OPTIMIZER_MODE,
  };
  // A local endpoint needs no key, which is the path under test. An ambient key
  // would otherwise change which branch runs.
  delete process.env.TOKEN_OPTIMIZER_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.TOKEN_OPTIMIZER_MODE;
});

afterEach(async () => {
  for (const [k, v] of [
    ['TOKEN_OPTIMIZER_HARVEST_ENDPOINT', saved.endpoint],
    ['TOKEN_OPTIMIZER_API_KEY', saved.key],
    ['ANTHROPIC_API_KEY', saved.anthropic],
    ['TOKEN_OPTIMIZER_MODE', saved.mode],
  ]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (server) await new Promise((r) => server.close(r));
  server = null;
});

describe('the harvester speaks the dialect its endpoint speaks', () => {
  test('an OpenAI-compatible local server produces findings', async () => {
    // THE CASE THAT RETURNED NOTHING. This is the shape ollama, LM Studio and
    // llama.cpp serve, so it is what a user following the advice actually gets.
    await start();
    process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT = `http://127.0.0.1:${port}/v1/chat/completions`;

    const out = await extract('a digest', { timeoutMs: 4000 });

    expect(out).toHaveLength(1);
    expect(out[0].claim).toBe('the stand-in model answered');
    expect(harvestFailure()).toBeNull();
  });

  test('the OpenAI request carries the prompt as a system MESSAGE', async () => {
    // Not a top-level `system` field: that dialect has none, and a server that
    // ignores the unknown key would answer without the instructions at all --
    // failing as bad extractions rather than as an error.
    await start();
    process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT = `http://127.0.0.1:${port}/v1/chat/completions`;

    await extract('a digest', { timeoutMs: 4000 });

    expect(seen.body.system).toBeUndefined();
    expect(seen.body.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(seen.body.messages[0].content.length).toBeGreaterThan(0);
    expect(seen.body.messages[1].content).toBe('a digest');
    // An Anthropic-only header on an OpenAI server is noise at best.
    expect(seen.headers['anthropic-version']).toBeUndefined();
  });

  test('the Anthropic dialect is unchanged', async () => {
    // The path that already worked must keep working, or this trades one broken
    // configuration for another.
    await start();
    process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT = `http://127.0.0.1:${port}/v1/messages`;

    const out = await extract('a digest', { timeoutMs: 4000 });

    expect(out).toHaveLength(1);
    expect(seen.body.system.length).toBeGreaterThan(0);
    expect(seen.body.messages.map((m) => m.role)).toEqual(['user']);
    expect(seen.headers['anthropic-version']).toBe('2023-06-01');
  });

  test('an AMBIENT key never travels to a local server', async () => {
    // ANTHROPIC_API_KEY is set on most machines that run Claude at all and says
    // nothing about the endpoint the user pointed this at -- which may be any
    // process listening on loopback. Sending it there is a leak, not a courtesy.
    process.env.ANTHROPIC_API_KEY = 'sk-should-not-travel';
    await start();
    process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT = `http://127.0.0.1:${port}/v1/chat/completions`;

    const out = await extract('a digest', { timeoutMs: 4000 });

    // PINNED POSITIVELY FIRST. The absence below is only evidence if the call
    // was actually made -- otherwise a harvester that never fired would satisfy
    // it, which is the exact failure this file exists to expose elsewhere.
    expect(seen).not.toBeNull();
    expect(out).toHaveLength(1);
    expect(seen.headers.authorization).toBeUndefined();
    expect(JSON.stringify(seen.headers)).not.toContain('sk-should-not-travel');
  });

  test('an EXPLICIT key does travel, so an authenticated local server works', async () => {
    // The counterpart, or the rule above would simply be 'never authenticate',
    // which breaks LM Studio and llama.cpp started with a key. Setting
    // TOKEN_OPTIMIZER_API_KEY is a statement about THIS endpoint.
    process.env.TOKEN_OPTIMIZER_API_KEY = 'sk-explicitly-for-this';
    await start();
    process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT = `http://127.0.0.1:${port}/v1/chat/completions`;

    await extract('a digest', { timeoutMs: 4000 });

    expect(seen.headers.authorization).toBe('Bearer sk-explicitly-for-this');
  });

  test('a misconfigured endpoint says why instead of going quiet', async () => {
    // The defect that hid all of this: an empty result meant both "nothing to
    // learn" and "your endpoint is wrong", so nobody could tell which they had.
    await start({ status: 404 });
    process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT = `http://127.0.0.1:${port}/v1/chat/completions`;

    const out = await extract('a digest', { timeoutMs: 4000 });

    expect(out).toEqual([]);
    expect(harvestFailure()).toContain('404');
  });

  test('an unrecognised reply shape is reported, not swallowed', async () => {
    await start({ shape: 'neither' });
    // Answers Anthropic-shaped to a chat/completions request: what a gateway
    // that speaks the other dialect looks like from here.
    process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT = `http://127.0.0.1:${port}/v1/chat/completions`;

    const out = await extract('a digest', { timeoutMs: 4000 });

    // Reading BOTH shapes is deliberate, so this one still succeeds -- the
    // reply is understood even though the dialect was not the one requested.
    expect(out).toHaveLength(1);
    expect(harvestFailure()).toBeNull();
  });

  test('the dialect is read from the URL', async () => {
    expect(endpointDialect('http://127.0.0.1:11434/v1/chat/completions')).toBe('openai');
    expect(endpointDialect('https://api.anthropic.com/v1/messages')).toBe('anthropic');
    expect(endpointDialect('')).toBe('anthropic');
  });
});
