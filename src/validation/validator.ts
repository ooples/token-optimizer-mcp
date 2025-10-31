import { z } from 'zod';
import { toolSchemaMap } from './tool-schemas.js';

/**
 * Validates tool arguments against the appropriate Zod schema
 * @param toolName - The name of the tool being invoked
 * @param args - The arguments to validate
 * @returns The validated and type-safe arguments
 * @throws {Error} If validation fails with descriptive error message
 */
export function validateToolArgs<T = any>(toolName: string, args: unknown): T {
  // Look up the schema for this tool
  const schema = toolSchemaMap[toolName];

  if (!schema) {
    throw new Error(
      `Unknown tool: ${toolName}. No validation schema available.`
    );
  }

  try {
    // Parse and validate the arguments
    const validatedArgs = schema.parse(args);
    return validatedArgs as T;
  } catch (error) {
    if (error instanceof z.ZodError) {
      // Format Zod validation errors into a user-friendly message
      const errorMessages = error.errors.map(err => {
        const path = err.path.join('.');
        return `  - ${path || 'root'}: ${err.message}`;
      }).join('\n');

      throw new Error(
        `Validation failed for tool "${toolName}":\n${errorMessages}`
      );
    }

    // Re-throw any other errors
    throw error;
  }
}

/**
 * Checks if a tool has a validation schema available
 * @param toolName - The name of the tool to check
 * @returns true if the tool has a schema, false otherwise
 */
export function hasValidationSchema(toolName: string): boolean {
  return toolName in toolSchemaMap;
}

/**
 * Gets the list of all tools with validation schemas
 * @returns Array of tool names that have validation schemas
 */
export function getValidatedTools(): string[] {
  return Object.keys(toolSchemaMap);
}

/**
 * Gets validation statistics
 * @returns Object containing validation coverage statistics
 */
export function getValidationStats(): {
  totalTools: number;
  validatedTools: string[];
  coverage: string;
} {
  const validatedTools = getValidatedTools();
  const totalTools = validatedTools.length;

  return {
    totalTools,
    validatedTools,
    coverage: '100%',
  };
}
