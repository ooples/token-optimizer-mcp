import { IFoundationModel, GenerationOptions } from '../interfaces/IFoundationModel.js';

/**
 * Mock foundation model for testing and demonstration
 * In production, this would be replaced with actual API calls to GPT-4, Claude, etc.
 */
export class MockFoundationModel implements IFoundationModel {
  private modelName: string;

  constructor(modelName: string = 'mock-model') {
    this.modelName = modelName;
  }

  async generate(prompt: string, _options?: GenerationOptions): Promise<string> {
    // Simple mock implementation that shortens text
    // In production, this would call actual LLM APIs

    // Extract the text to summarize from the prompt
    const textMatch = prompt.match(/Text to summarize:\n([\s\S]*?)\n\nSummary:/);
    if (!textMatch) {
      return 'Unable to generate summary';
    }

    const textToSummarize = textMatch[1];

    // Simple summarization: take first and last sentences and key phrases
    const sentences = textToSummarize.split(/[.!?]+/).filter(s => s.trim().length > 0);

    if (sentences.length === 0) {
      return 'Empty content';
    }

    if (sentences.length === 1) {
      return sentences[0].trim() + '.';
    }

    // Create a simple summary
    const targetLength = Math.floor(textToSummarize.length * 0.3);

    let summary = '';
    if (sentences.length > 2) {
      // Take first sentence, mention key content, and last sentence
      summary = `${sentences[0].trim()}. [Content summarized: ${sentences.length - 2} additional points]. ${sentences[sentences.length - 1].trim()}.`;
    } else {
      summary = sentences.join('. ') + '.';
    }

    // Ensure summary is shorter than original
    if (summary.length > targetLength) {
      summary = summary.substring(0, targetLength) + '...';
    }

    return summary;
  }

  getModelName(): string {
    return this.modelName;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}
