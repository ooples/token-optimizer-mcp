/**
 * Interface for foundation model providers (GPT-4, Claude, etc.)
 */

export interface GenerationOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
}

export interface IFoundationModel {
  /**
   * Generate text completion using the foundation model
   */
  generate(prompt: string, options?: GenerationOptions): Promise<string>;

  /**
   * Get the model identifier
   */
  getModelName(): string;

  /**
   * Check if the model is available
   */
  isAvailable(): Promise<boolean>;
}
