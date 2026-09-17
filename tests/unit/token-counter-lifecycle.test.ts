import { describe, it, expect, jest } from '@jest/globals';
import { TokenCounter } from '../../src/core/token-counter.js';
import { TokenizerFactory } from '../../src/core/tokenizers/tokenizer-factory.js';

describe('lazy counter ownership', () => {
  it('counts repeated long slices exactly without repeatedly allocating token arrays', () => {
    const counter = new TokenCounter('gpt-4');
    const chunk = 'x'.repeat(8192);
    const expectedPerChunk = counter.count(chunk).tokens;
    const internals = counter as unknown as {
      localEncoder: { encode(text: string): Uint32Array };
    };
    const encode = jest.spyOn(internals.localEncoder, 'encode');
    try {
      expect(counter.count(chunk.repeat(64)).tokens).toBe(
        expectedPerChunk * 64
      );
      expect(encode).toHaveBeenCalledTimes(1);
    } finally {
      encode.mockRestore();
      counter.free();
    }
  });
  it('does not create an async tokenizer for synchronous work or cleanup', () => {
    const create = jest.spyOn(TokenizerFactory, 'create');
    const unused = new TokenCounter('gpt-4');
    const used = new TokenCounter('gpt-4');
    try {
      unused.free();
      unused.free();
      expect(used.count('Hello, world!').tokens).toBe(4);
      expect(used.truncate('Hello, world!', 1)).toBe('Hello');
      used.free();
      used.free();
      expect(create).not.toHaveBeenCalled();
      expect(() => unused.count('anything')).toThrow('freed');
      expect(() => used.count('Hello, world!')).toThrow('freed');
      expect(() => used.truncate('Hello', 1)).toThrow('freed');
    } finally {
      unused.free();
      used.free();
      create.mockRestore();
    }
  });

  it('keeps shared async tokenizers alive when another counter is freed', async () => {
    const first = new TokenCounter('gpt-4');
    const second = new TokenCounter('gpt-4');
    try {
      expect((await first.countAsync('Hello, world!')).tokens).toBe(4);
      first.free();
      await expect(first.countAsync('Hello')).rejects.toThrow('freed');
      expect((await second.countAsync('Hello, world!')).tokens).toBe(4);
      expect(second.count('Hello, world!').tokens).toBe(4);
    } finally {
      first.free();
      second.free();
    }
  });
});
