import { SummarizationModule } from '../modules/SummarizationModule.js';

export class MarkerBasedOptimizer {
  constructor(private summarizationModule: SummarizationModule) {}

  async processMarkers(prompt: string): Promise<string> {
    const regex = /<summarize>([\s\S]*?)<\/summarize>/g;
    let result = prompt;
    const matches: Array<{ match: string; text: string }> = [];
    let match;

    // Collect all matches first to avoid issues with string replacement during iteration
    while ((match = regex.exec(prompt)) !== null) {
      matches.push({
        match: match[0],
        text: match[1],
      });
    }

    // Process each match
    for (const { match: matchText, text: textToSummarize } of matches) {
      const summaryResult =
        await this.summarizationModule.summarize(textToSummarize);
      result = result.replace(matchText, summaryResult.summary);
    }

    return result;
  }
}
