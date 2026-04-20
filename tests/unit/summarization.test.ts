import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
    TruncatingSummarizer,
    AnthropicSummarizer,
    GoogleAISummarizer,
    createSummarizerFromEnv,
} from '../../src/core/summarization.js';
import { Message } from '../../src/core/session.js';

function makeMessages(n: number): Message[] {
    return Array.from({ length: n }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as Message['role'],
        content: `Turn ${i}: ${'x'.repeat(50)}`,
        timestamp: Date.now() + i,
    }));
}

describe('TruncatingSummarizer', () => {
    it('returns empty string for empty input', async () => {
        const s = new TruncatingSummarizer();
        expect(await s.summarize([])).toBe('');
    });

    it('returns untruncated text when under maxChars', async () => {
        const s = new TruncatingSummarizer({ maxChars: 10_000 });
        const out = await s.summarize(makeMessages(3));
        expect(out).toContain('Turn 0');
        expect(out).toContain('Turn 2');
        expect(out).not.toContain('[truncated]');
    });

    it('truncates with a marker when over maxChars', async () => {
        const s = new TruncatingSummarizer({ maxChars: 500 });
        const out = await s.summarize(makeMessages(50));
        expect(out).toContain('[truncated]');
        expect(out.length).toBeLessThan(600);
    });
});

describe('AnthropicSummarizer / GoogleAISummarizer constructors', () => {
    const savedAnthropic = process.env.ANTHROPIC_API_KEY;
    const savedGoogle = process.env.GOOGLE_AI_API_KEY;

    beforeEach(() => {
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.GOOGLE_AI_API_KEY;
    });
    afterEach(() => {
        if (savedAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropic;
        else delete process.env.ANTHROPIC_API_KEY;
        if (savedGoogle !== undefined) process.env.GOOGLE_AI_API_KEY = savedGoogle;
        else delete process.env.GOOGLE_AI_API_KEY;
    });

    it('AnthropicSummarizer throws without a key', () => {
        expect(() => new AnthropicSummarizer()).toThrow(/ANTHROPIC_API_KEY/);
    });

    it('GoogleAISummarizer throws without a key', () => {
        expect(() => new GoogleAISummarizer()).toThrow(/GOOGLE_AI_API_KEY/);
    });

    it('AnthropicSummarizer constructs with explicit apiKey', () => {
        expect(() => new AnthropicSummarizer({ apiKey: 'sk-test' })).not.toThrow();
    });

    it('GoogleAISummarizer constructs with explicit apiKey', () => {
        expect(() => new GoogleAISummarizer({ apiKey: 'gapi-test' })).not.toThrow();
    });
});

describe('createSummarizerFromEnv', () => {
    const saved = {
        anthropic: process.env.ANTHROPIC_API_KEY,
        google: process.env.GOOGLE_AI_API_KEY,
    };

    afterEach(() => {
        if (saved.anthropic !== undefined) process.env.ANTHROPIC_API_KEY = saved.anthropic;
        else delete process.env.ANTHROPIC_API_KEY;
        if (saved.google !== undefined) process.env.GOOGLE_AI_API_KEY = saved.google;
        else delete process.env.GOOGLE_AI_API_KEY;
    });

    it('falls back to TruncatingSummarizer when no keys are set', () => {
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.GOOGLE_AI_API_KEY;
        expect(createSummarizerFromEnv()).toBeInstanceOf(TruncatingSummarizer);
    });

    it('prefers Anthropic when its key is set', () => {
        process.env.ANTHROPIC_API_KEY = 'sk-test';
        delete process.env.GOOGLE_AI_API_KEY;
        expect(createSummarizerFromEnv()).toBeInstanceOf(AnthropicSummarizer);
    });

    it('uses Google AI when only its key is set', () => {
        delete process.env.ANTHROPIC_API_KEY;
        process.env.GOOGLE_AI_API_KEY = 'gapi-test';
        expect(createSummarizerFromEnv()).toBeInstanceOf(GoogleAISummarizer);
    });
});
