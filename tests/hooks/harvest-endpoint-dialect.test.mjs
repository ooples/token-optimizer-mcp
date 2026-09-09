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
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extract,
  harvestFailure,
  endpointDialect,
  credentialFor,
  validate,
  FINDINGS_SCHEMA,
} from '../../hooks-core/harvest.mjs';

const HARVEST_MODULE = new URL('../../hooks-core/harvest.mjs', import.meta.url).href;

// The recorded failure now outlives the process that recorded it, so a test
// run must not write into the developer's own ~/.token-optimizer.
const stateDir = mkdtempSync(join(tmpdir(), 'harvest-state-'));
const stateFile = join(stateDir, 'last-harvest.json');

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
/** One entry per request reaching the server: did it carry a schema? */
let attempts;
let saved;

/** Answers in whichever dialect the path asks for, and records the request. */
const start = ({ status = 200, shape = 'auto', rejectSchema = false } = {}) =>
  new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        const parsed = raw ? JSON.parse(raw) : null;
        seen = { url: req.url, headers: req.headers, body: parsed };
        attempts.push(Boolean(parsed && parsed.response_format));
        // A server that predates structured outputs refuses the request whole.
        if (rejectSchema && parsed && parsed.response_format) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end('{"error":"response_format is not supported"}');
          return;
        }
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
  attempts = [];
  // The recorded failure is now written to disk so it can cross a process
  // boundary; point it at a temp file so a test run never touches the
  // developer's own ~/.token-optimizer.
  process.env.TOKEN_OPTIMIZER_HARVEST_STATE = stateFile;
  saved = {
    endpoint: process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT,
    key: process.env.TOKEN_OPTIMIZER_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    mode: process.env.TOKEN_OPTIMIZER_MODE,
    // harvestMode() reads this BEFORE it looks at the endpoint, so an
    // inherited '0' would return off:opted-out and no request would ever
    // reach the server -- every request assertion below would fail for a
    // reason that has nothing to do with its subject.
    harvest: process.env.TOKEN_OPTIMIZER_HARVEST,
    model: process.env.TOKEN_OPTIMIZER_HARVEST_MODEL,
  };
  // A local endpoint needs no key, which is the path under test. An ambient key
  // would otherwise change which branch runs.
  delete process.env.TOKEN_OPTIMIZER_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.TOKEN_OPTIMIZER_MODE;
  delete process.env.TOKEN_OPTIMIZER_HARVEST;
  // The OpenAI dialect now refuses to guess a model, since the Anthropic
  // default names something no local server serves. These tests are about
  // the request, not that guard, so they state one.
  process.env.TOKEN_OPTIMIZER_HARVEST_MODEL = 'test-model';
});

afterEach(async () => {
  for (const [k, v] of [
    ['TOKEN_OPTIMIZER_HARVEST_ENDPOINT', saved.endpoint],
    ['TOKEN_OPTIMIZER_API_KEY', saved.key],
    ['ANTHROPIC_API_KEY', saved.anthropic],
    ['TOKEN_OPTIMIZER_MODE', saved.mode],
    ['TOKEN_OPTIMIZER_HARVEST', saved.harvest],
    ['TOKEN_OPTIMIZER_HARVEST_MODEL', saved.model],
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

/**
 * A small local model will not follow the prompt without being made to.
 *
 * Measured against qwen2.5:3b through ollama on this session's real digest:
 * unconstrained it answered with a prose summary and zero findings;
 * `json_object` gave valid JSON in a schema it invented; `json_schema` gave one
 * finding in the exact required shape in 9s. Since the whole point of the local
 * path is that a modest model can run it for free, the schema is sent rather
 * than hoped for.
 */
/**
 * The schema is a CLOSED object, so a field the prompt asks for and the
 * schema does not declare cannot be returned at all.
 */
describe('the schema declares every field the prompt asks for', () => {
  const item = () => FINDINGS_SCHEMA.properties.findings.items;

  test('scope and invalidators are declared and required', () => {
    // additionalProperties is false, so omitting them from `properties` did
    // not merely leave them optional -- it FORBADE them. An enforcing server
    // could not return either one, `validate` substituted `project` and `[]`
    // for every finding, and the substitution is silent: no finding from the
    // schema path could ever be promoted beyond its own project or carry an
    // invalidator.
    expect(item().additionalProperties).toBe(false);
    expect(Object.keys(item().properties)).toEqual(expect.arrayContaining(['scope', 'invalidators']));
    expect(item().required).toEqual(expect.arrayContaining(['scope', 'invalidators']));
  });

  test('the declared scopes are the ones validate() accepts', () => {
    // A schema offering a scope the gate rejects would send the model to a
    // value that is silently rewritten, which is the same bug one level down.
    const declared = item().properties.scope.enum;
    for (const scope of declared) {
      const [kept] = validate(
        [
          {
            type: 'finding',
            claim: 'a claim long enough to pass the gate',
            evidence: 'the evidence that proved it',
            applicability: 'when testing',
            confidenceLabel: 'verified',
            scope,
            invalidators: ['the schema changes'],
            anchors: ['hooks-core/harvest.mjs'],
          },
        ],
        { knownFiles: new Set(['hooks-core/harvest.mjs']) }
      );
      expect(kept.scope).toBe(scope);
      expect(kept.invalidators).toEqual(['the schema changes']);
    }
  });
});

/**
 * The reason a harvest produced nothing has to reach the process that reports it.
 */
describe('the recorded failure outlives the process that recorded it', () => {
  const run = (script) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TOKEN_OPTIMIZER_HARVEST_STATE: stateFile,
        TOKEN_OPTIMIZER_HARVEST_ENDPOINT: '',
        TOKEN_OPTIMIZER_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
    });

  beforeEach(() => {
    if (existsSync(stateFile)) rmSync(stateFile);
  });

  test('a failure in one process is readable in the next', () => {
    // THE BUG THIS EXISTS FOR. The harvest runs in a DETACHED worker spawned
    // at Stop; `doctor` is a separate node invocation importing a fresh copy
    // of the module. A module-local variable cannot cross that boundary, so
    // probeHarvest read null no matter what the harvest had done and the
    // failure branch built to surface the reason was unreachable from the
    // diagnostic that exists to surface it.
    const recorded = run(
      `import { extract, harvestFailure } from ${JSON.stringify(HARVEST_MODULE)};` +
        `await extract('');` +
        `process.stdout.write(String(harvestFailure()));`
    );
    expect(recorded.status).toBe(0);
    expect(recorded.stdout).toContain('no digest');

    const read = run(
      `import { harvestFailure } from ${JSON.stringify(HARVEST_MODULE)};` +
        `process.stdout.write(String(harvestFailure()));`
    );
    expect(read.status).toBe(0);
    expect(read.stdout).toContain('no digest');
  });

  test('a record older than the TTL is not reported as current', () => {
    // A harvest runs at the end of every session, so a week-old record means
    // the harvest has not run since -- calling that the current state is a
    // guess, and a guess that keeps a fixed configuration looking broken.
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const write = run(
      `import { writeFileSync } from 'node:fs';` +
        `writeFileSync(process.env.TOKEN_OPTIMIZER_HARVEST_STATE, JSON.stringify({ reason: 'ancient', at: ${old} }));`
    );
    expect(write.status).toBe(0);

    const read = run(
      `import { harvestFailure } from ${JSON.stringify(HARVEST_MODULE)};` +
        `process.stdout.write(String(harvestFailure()));`
    );
    expect(read.stdout.trim()).toBe('null');
  });

  test('a harvest that works clears the record', () => {
    // Otherwise the file is a one-way latch: the user fixes their endpoint and
    // doctor keeps reporting last week's failure. The TTL expires a stale
    // record, not a wrong one.
    run(
      `import { extract } from ${JSON.stringify(HARVEST_MODULE)};` + `await extract('');`
    );
    const cleared = run(
      `import { writeFileSync } from 'node:fs';` +
        `writeFileSync(process.env.TOKEN_OPTIMIZER_HARVEST_STATE, JSON.stringify({ reason: null, at: Date.now() }));`
    );
    expect(cleared.status).toBe(0);

    const read = run(
      `import { harvestFailure } from ${JSON.stringify(HARVEST_MODULE)};` +
        `process.stdout.write(String(harvestFailure()));`
    );
    expect(read.stdout.trim()).toBe('null');
  });
});

describe('the reply shape is enforced where the server can enforce it', () => {
  test('the OpenAI request carries the findings schema', async () => {
    await start();
    process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT = `http://127.0.0.1:${port}/v1/chat/completions`;

    const out = await extract('a digest', { timeoutMs: 4000 });

    expect(out).toHaveLength(1);
    expect(seen.body.response_format.type).toBe('json_schema');
    expect(seen.body.response_format.json_schema.schema).toEqual(FINDINGS_SCHEMA);
    // One request only: nothing to fall back from.
    expect(attempts).toEqual([true]);
  });

  test('the Anthropic request carries none, because that dialect has none', async () => {
    await start();
    process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT = `http://127.0.0.1:${port}/v1/messages`;

    await extract('a digest', { timeoutMs: 4000 });

    expect(seen.body.response_format).toBeUndefined();
    expect(attempts).toEqual([false]);
  });

  test('a server that refuses the schema still gets an answer', async () => {
    // THE COMPATIBILITY CASE. A server predating structured outputs rejects the
    // request outright, and the unconstrained call is exactly what this
    // function used to send -- so refusing the schema must cost the reply, not
    // the harvest.
    await start({ rejectSchema: true });
    process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT = `http://127.0.0.1:${port}/v1/chat/completions`;

    const out = await extract('a digest', { timeoutMs: 4000 });

    expect(out).toHaveLength(1);
    expect(harvestFailure()).toBeNull();
    // Exactly two attempts, the second without the schema. Not three, and not
    // a retry loop.
    expect(attempts).toEqual([true, false]);
  });

  test('a server error is NOT retried', async () => {
    // A 5xx or a timeout is a condition a second identical call would only pay
    // for twice, on a hook path. Only a refusal of what was sent is retried.
    await start({ status: 503 });
    process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT = `http://127.0.0.1:${port}/v1/chat/completions`;

    const out = await extract('a digest', { timeoutMs: 4000 });

    expect(out).toEqual([]);
    expect(harvestFailure()).toContain('503');
    expect(attempts).toHaveLength(1);
  });
});

/**
 * Anchors are offered as a choice, not requested in prose.
 *
 * `validate` holds anchors to the files the session actually touched, and a
 * model asked in English for a path writes a plausible one instead of a real
 * one -- so every finding was discarded at the gate. Measured over runs of
 * qwen2.5:7b on this session's real digest, against that same gate:
 * unconstrained, 0 of 6 runs yielded an accepted finding; enum-constrained,
 * 5 of 6. Nothing else differed.
 */
describe('the model is given the anchors rather than asked for them', () => {
  const anchorSpec = () =>
    seen.body.response_format.json_schema.schema
      .properties.findings.items.properties.anchors;

  test('known files become the permitted anchor set', async () => {
    await start();
    process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT = `http://127.0.0.1:${port}/v1/chat/completions`;

    await extract('a digest', {
      timeoutMs: 4000,
      knownFiles: new Set(['hooks-core/harvest.mjs', 'hooks-core/derive.mjs']),
    });

    expect(anchorSpec().items.enum).toEqual([
      'hooks-core/harvest.mjs',
      'hooks-core/derive.mjs',
    ]);
  });

  test('no list means no restriction, not an empty one', async () => {
    // An empty enum would forbid EVERY anchor rather than free them, which is
    // the failure mode for buildFullDelta -- raw transcript with no file
    // heading, whose caller deliberately passes nothing.
    await start();
    process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT = `http://127.0.0.1:${port}/v1/chat/completions`;

    await extract('a digest', { timeoutMs: 4000 });

    expect(anchorSpec().items.enum).toBeUndefined();
    expect(anchorSpec()).toEqual({ type: 'array', items: { type: 'string' } });
  });

  test('an empty known set is treated as no list', async () => {
    await start();
    process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT = `http://127.0.0.1:${port}/v1/chat/completions`;

    await extract('a digest', { timeoutMs: 4000, knownFiles: new Set() });

    expect(anchorSpec().items.enum).toBeUndefined();
  });
});

/**
 * A credential belongs to the endpoint it was issued for, and nowhere else.
 *
 * `apiKey()` falls back to ANTHROPIC_API_KEY, which is set on most machines
 * that run Claude and says nothing about where a request is going. The first
 * version of this scoped on locality alone -- closing the loopback leak and
 * leaving open the one that matters more, an Anthropic key sent as a Bearer
 * token to a third-party OpenAI-compatible gateway.
 */
describe('an Anthropic key travels only to Anthropic', () => {
  const ambient = { ANTHROPIC_API_KEY: 'sk-ant-ambient' };
  const explicit = { ANTHROPIC_API_KEY: 'sk-ant-ambient', TOKEN_OPTIMIZER_API_KEY: 'sk-explicit' };

  test('only a remote Anthropic endpoint receives the ambient key', () => {
    expect(credentialFor('anthropic', false, ambient)).toBe('sk-ant-ambient');
    expect(credentialFor('anthropic', true, ambient)).toBeNull();
    expect(credentialFor('openai', true, ambient)).toBeNull();
    // The case review caught: remote, but not Anthropic.
    expect(credentialFor('openai', false, ambient)).toBeNull();
  });

  test('an explicit key reaches every destination, because it was chosen', () => {
    for (const dialect of ['anthropic', 'openai']) {
      for (const local of [true, false]) {
        expect(credentialFor(dialect, local, explicit)).toBe('sk-explicit');
      }
    }
  });
});

/**
 * The default model is an Anthropic one, and a local server has never heard of
 * it. A user following the documented advice sets only the endpoint, so the
 * request asks ollama for `claude-haiku-...` and is refused -- silently, before
 * this. Refused with a reason naming the variable instead of guessed at: a
 * default like `llama3.2` is a guess about what the user pulled, and being
 * wrong costs the same silent nothing.
 */
describe('an OpenAI endpoint must be told which model to use', () => {
  test('it refuses, naming the variable, rather than asking for a Claude model', async () => {
    await start();
    delete process.env.TOKEN_OPTIMIZER_HARVEST_MODEL;
    process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT = `http://127.0.0.1:${port}/v1/chat/completions`;

    const out = await extract('a digest', { timeoutMs: 4000 });

    expect(out).toEqual([]);
    expect(harvestFailure()).toContain('TOKEN_OPTIMIZER_HARVEST_MODEL');
    // And it never reached the server, so no wrong-model request was made.
    expect(seen).toBeNull();
  });

  test('the Anthropic dialect keeps its default, which is correct there', async () => {
    await start();
    delete process.env.TOKEN_OPTIMIZER_HARVEST_MODEL;
    process.env.TOKEN_OPTIMIZER_API_KEY = 'sk-explicit';
    process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT = `http://127.0.0.1:${port}/v1/messages`;

    const out = await extract('a digest', { timeoutMs: 4000 });

    expect(out).toHaveLength(1);
    expect(seen.body.model).toContain('claude');
  });
});
