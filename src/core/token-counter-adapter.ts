/**
 * Adapter to make TokenCounter implement ITokenCounter interface
 */

import {
  ITokenCounter,
  TokenCountResult,
} from '../interfaces/ITokenCounter.js';
import { TokenCounter } from './token-counter.js';

export class TokenCounterAdapter implements ITokenCounter {
  constructor(private tokenCounter: TokenCounter) {}

  count(text: string): TokenCountResult {
    return this.tokenCounter.count(text);
  }

  countBatch(texts: string[]): TokenCountResult {
    return this.tokenCounter.countBatch(texts);
  }

  estimate(text: string): number {
    return this.tokenCounter.estimate(text);
  }
}
