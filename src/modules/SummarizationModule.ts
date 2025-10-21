import { IFoundationModel } from '../interfaces/IFoundationModel.js';
import { ITokenCounter } from '../interfaces/ITokenCounter.js';
import { IMetrics } from '../interfaces/IMetrics.js';

export interface SummarizationOptions {
  maxOutputTokens?: number;
  compressionRatio?: number;
  preserveCodeBlocks?: boolean;
  style?: 'concise' | 'detailed' | 'bullets';
}

export interface SummarizationResult {
  summary: string;
  originalTokens: number;
  summaryTokens: number;
  compressionRatio: number;
}

export class SummarizationModule {
  constructor(
    private model: IFoundationModel,
    private tokenCounter: ITokenCounter,
    private metrics?: IMetrics
  ) {}

  async summarize(
    text: string,
    options: SummarizationOptions = {}
  ): Promise<SummarizationResult> {
    const startTime = Date.now();
    const originalTokenResult = await Promise.resolve(
      this.tokenCounter.count(text)
    );
    const originalTokens = originalTokenResult.tokens;

    // Build summarization prompt
    const prompt = this.buildSummarizationPrompt(text, options);

    // Generate summary using foundation model
    const summary = await this.model.generate(prompt, {
      maxTokens: options.maxOutputTokens || Math.floor(originalTokens * 0.3),
      temperature: 0.3, // Lower temperature for factual summarization
    });

    const summaryTokenResult = await Promise.resolve(
      this.tokenCounter.count(summary)
    );
    const summaryTokens = summaryTokenResult.tokens;
    const compressionRatio = summaryTokens / originalTokens;

    // Track metrics
    if (this.metrics) {
      this.metrics.recordSummarization({
        originalTokens,
        summaryTokens,
        compressionRatio,
        latency: Date.now() - startTime,
      });
    }

    return {
      summary,
      originalTokens,
      summaryTokens,
      compressionRatio,
    };
  }

  private buildSummarizationPrompt(
    text: string,
    options: SummarizationOptions
  ): string {
    const style = options.style || 'concise';
    const targetLength = options.maxOutputTokens
      ? `approximately ${options.maxOutputTokens} tokens`
      : `about ${Math.floor(text.length * 0.3)} characters`;

    let prompt = `Please provide a ${style} summary of the following text in ${targetLength}:\n\n`;

    if (options.preserveCodeBlocks) {
      prompt +=
        'IMPORTANT: Preserve all code blocks and technical details exactly as written.\n\n';
    }

    prompt += `Text to summarize:\n${text}\n\nSummary:`;

    return prompt;
  }
}
