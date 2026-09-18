/**
 * The OrcaRouter summarizer: this package's own model calls, through the provider seam.
 *
 * The adapter is selected only when a credential exists AND a model has been chosen, so a machine
 * that merely has an OrcaRouter key in its environment does not silently start routing summaries
 * through a gateway nobody selected. When it is selected, the request goes to the relay's chat
 * completions path with a Bearer header, and a model id is never invented.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OrcaRouterSummarizer,
  configuredOrcaModel,
} from '../../src/orcarouter/summarizer.js';
import {
  createSummarizerFromEnv,
  TruncatingSummarizer,
  AnthropicSummarizer,
} from '../../src/core/summarization.js';
import { saveCredential } from '../../src/orcarouter/credential-store.js';
import type { Message } from '../../src/core/session.js';

const FAKE_KEY = 'sk-orca-aaaaaaaaaaaaaaaaaaaa';

const messages: Message[] = [
  { role: 'user', content: 'We decided to use the proxy.', timestamp: 1 },
  { role: 'assistant', content: 'TODO: verify the catalog.', timestamp: 2 },
];

let home: string;
let env: NodeJS.ProcessEnv;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-summarizer-'));
  env = { TOKEN_OPTIMIZER_HOME: home };
  for (const key of [
    'ANTHROPIC_API_KEY',
    'GOOGLE_AI_API_KEY',
    'TOKEN_OPTIMIZER_ORCA_MODEL',
  ])
    saved[key] = process.env[key];
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GOOGLE_AI_API_KEY;
  delete process.env.TOKEN_OPTIMIZER_ORCA_MODEL;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('OrcaRouterSummarizer', () => {
  it('requires a model id rather than guessing one', () => {
    expect(() => new OrcaRouterSummarizer({ env })).toThrow(/needs a model id/);
    expect(configuredOrcaModel(env)).toBeNull();
    expect(
      configuredOrcaModel({ TOKEN_OPTIMIZER_ORCA_MODEL: '  ' })
    ).toBeNull();
    expect(
      configuredOrcaModel({ TOKEN_OPTIMIZER_ORCA_MODEL: 'orcarouter/auto' })
    ).toBe('orcarouter/auto');
  });

  it('posts a chat completion to the relay with a Bearer header and the chosen model', async () => {
    const calls: Array<{
      url: string;
      body: unknown;
      headers: Record<string, string>;
    }> = [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init.body)),
        headers: init.headers as Record<string, string>,
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: '  summarized  ' } }],
          }),
      });
    }) as unknown as typeof fetch;

    await saveCredential({ source: 'api-key', key: FAKE_KEY }, env);
    const summarizer = new OrcaRouterSummarizer({
      model: 'orcarouter/auto',
      env,
      fetchImpl,
    });
    const output = await summarizer.summarize(messages);

    expect(output).toBe('summarized');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.orcarouter.ai/v1/chat/completions');
    expect(calls[0].headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    const body = calls[0].body as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('orcarouter/auto');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].content).toContain('We decided to use the proxy.');
  });

  it('returns an empty string for no messages without making a request', async () => {
    let called = false;
    const summarizer = new OrcaRouterSummarizer({
      model: 'orcarouter/auto',
      env,
      fetchImpl: (() => {
        called = true;
        return Promise.reject(new Error('must not be called'));
      }) as unknown as typeof fetch,
    });
    expect(await summarizer.summarize([])).toBe('');
    expect(called).toBe(false);
  });

  it('never puts the key in a thrown error when the relay rejects the request', async () => {
    await saveCredential({ source: 'api-key', key: FAKE_KEY }, env);
    const summarizer = new OrcaRouterSummarizer({
      model: 'orcarouter/auto',
      env,
      fetchImpl: (() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({}),
        })) as unknown as typeof fetch,
    });
    const error = await summarizer
      .summarize(messages)
      .catch((caught: unknown) => caught);
    expect(String(error)).toMatch(/HTTP 500/);
    expect(String(error)).not.toContain(FAKE_KEY);
    expect(String(error)).not.toContain('sk-orca-');
  });
});

describe('selection in createSummarizerFromEnv', () => {
  it('stays on the truncating summarizer when no credential or no model is configured', async () => {
    expect(createSummarizerFromEnv()).toBeInstanceOf(TruncatingSummarizer);

    // A credential alone is not an instruction: without a selected model, nothing changes.
    await saveCredential(
      { source: 'api-key', key: FAKE_KEY },
      { TOKEN_OPTIMIZER_HOME: home }
    );
    process.env.TOKEN_OPTIMIZER_HOME = home;
    expect(createSummarizerFromEnv()).toBeInstanceOf(TruncatingSummarizer);
  });

  it('selects OrcaRouter once both a credential and a model are present', async () => {
    await saveCredential(
      { source: 'api-key', key: FAKE_KEY },
      { TOKEN_OPTIMIZER_HOME: home }
    );
    process.env.TOKEN_OPTIMIZER_HOME = home;
    process.env.TOKEN_OPTIMIZER_ORCA_MODEL = 'orcarouter/auto';
    expect(createSummarizerFromEnv()).toBeInstanceOf(OrcaRouterSummarizer);
  });

  it('keeps the existing Anthropic preference when no OrcaRouter model is selected', async () => {
    await saveCredential(
      { source: 'api-key', key: FAKE_KEY },
      { TOKEN_OPTIMIZER_HOME: home }
    );
    process.env.TOKEN_OPTIMIZER_HOME = home;
    process.env.ANTHROPIC_API_KEY = 'fake-anthropic-key';
    expect(createSummarizerFromEnv()).toBeInstanceOf(AnthropicSummarizer);
  });

  it('prefers OrcaRouter over Anthropic when the user has explicitly selected a model', async () => {
    await saveCredential(
      { source: 'api-key', key: FAKE_KEY },
      { TOKEN_OPTIMIZER_HOME: home }
    );
    process.env.TOKEN_OPTIMIZER_HOME = home;
    process.env.ANTHROPIC_API_KEY = 'fake-anthropic-key';
    process.env.TOKEN_OPTIMIZER_ORCA_MODEL = 'orcarouter/auto';
    expect(createSummarizerFromEnv()).toBeInstanceOf(OrcaRouterSummarizer);
  });
});
