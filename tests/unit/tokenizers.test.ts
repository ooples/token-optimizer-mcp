import { describe, it, expect } from '@jest/globals';
import { HeuristicTokenizer, ContentType } from '../../src/core/tokenizers/heuristic-tokenizer.js';
import { TokenizerFactory } from '../../src/core/tokenizers/tokenizer-factory.js';
import { TiktokenTokenizer } from '../../src/core/tokenizers/tiktoken-tokenizer.js';

describe('HeuristicTokenizer', () => {
  it('detects JSON content', () => {
    const json = '{"a": 1, "b": [1, 2, 3]}';
    expect(HeuristicTokenizer.detectContentType(json)).toBe(ContentType.Json);
  });

  it('detects code content', () => {
    const code = 'function foo() { return 42; }';
    expect(HeuristicTokenizer.detectContentType(code)).toBe(ContentType.Code);
  });

  it('detects markdown content', () => {
    const md = '# Heading\n\n- item one\n- item two';
    expect(HeuristicTokenizer.detectContentType(md)).toBe(ContentType.Markdown);
  });

  it('defaults to text content', () => {
    const text = 'Just a short plain sentence.';
    expect(HeuristicTokenizer.detectContentType(text)).toBe(ContentType.Text);
  });

  it('uses a lower chars/token ratio for code than text', async () => {
    const tokenizer = new HeuristicTokenizer();
    const code = 'function foo() { return 42; }';
    const text = 'A sentence of roughly similar length here.';
    const codeTokens = await tokenizer.countTokens(code);
    const textTokens = await tokenizer.countTokens(text);
    // Code has ratio 2.5 vs text 4.0 → for strings of similar length, code tokens > text tokens.
    expect(codeTokens / code.length).toBeGreaterThan(textTokens / text.length);
  });

  it('caches repeated inputs', async () => {
    const tokenizer = new HeuristicTokenizer();
    const input = 'cache me';
    const first = await tokenizer.countTokens(input);
    const second = await tokenizer.countTokens(input);
    expect(first).toBe(second);
  });
});

describe('TokenizerFactory', () => {
  it('returns a TiktokenTokenizer for gpt-4', () => {
    const t = TokenizerFactory.create('gpt-4');
    expect(t).toBeInstanceOf(TiktokenTokenizer);
    t.free();
  });

  it('returns a TiktokenTokenizer for Claude models (maps to gpt-4)', () => {
    const t = TokenizerFactory.create('claude-opus-4-7');
    expect(t).toBeInstanceOf(TiktokenTokenizer);
    t.free();
  });

  it('falls back to HeuristicTokenizer for unknown models', () => {
    const t = TokenizerFactory.create('some-unknown-local-model');
    expect(t).toBeInstanceOf(HeuristicTokenizer);
    t.free();
  });
});
