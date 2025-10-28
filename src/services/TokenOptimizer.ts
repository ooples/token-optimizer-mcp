import { IOptimizationModule } from '../modules/IOptimizationModule.js';
import { ITokenCounter } from '../interfaces/ITokenCounter.js';

export interface OptimizationResult {
  optimizedPrompt: string;
  originalTokens: number;
  optimizedTokens: number;
  savings: number;
  appliedModules: string[];
}

export class TokenOptimizer {
  constructor(
    private modules: IOptimizationModule[],
    private tokenCounter: ITokenCounter
  ) {}

  async optimize(prompt: string): Promise<OptimizationResult> {
    let current = prompt;
    const originalTokenResult = await Promise.resolve(
      this.tokenCounter.count(prompt)
    );
    const originalTokens = originalTokenResult.tokens;
    const appliedModules: string[] = [];

    // Apply each optimization module in order
    for (const module of this.modules) {
      const result = await module.apply(current);
      current = result.text;
      appliedModules.push(module.name);
    }

    const optimizedTokenResult = await Promise.resolve(
      this.tokenCounter.count(current)
    );
    const optimizedTokens = optimizedTokenResult.tokens;

    return {
      optimizedPrompt: current,
      originalTokens,
      optimizedTokens,
      savings: originalTokens - optimizedTokens,
      appliedModules,
    };
  }
}
