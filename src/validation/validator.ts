import { z } from 'zod';
import { toolSchemaMap } from './tool-schemas.js';

/**
 * Flattens a union failure down to the issues that name actual fields.
 *
 * A published `anyOf` derives to a zod union, and a union reports ONE issue at
 * the root -- `invalid_union`, message "Invalid input" -- with every branch's
 * real issues buried in `unionErrors`. So a caller who omitted `optimizedText`
 * from an optimization_storage `store` was told only that their request was
 * invalid, with no path and no field name: the one thing they could not work
 * out for themselves.
 *
 * The branch the caller was aiming at is the one whose discriminator matched:
 * a conditional branch pins `operation` to a constant, so a branch that
 * complains about `operation` is a branch about some other operation. Among
 * the branches that agree with the operation requested, the one with the
 * fewest remaining issues is the nearest miss, and its issues are what the
 * caller needs to read.
 *
 * Fewest-issues alone was not enough, and it failed in the direction that
 * reads as nonsense: a `store` missing its four payload fields was answered
 * with `operation: Invalid literal value, expected "retrieve"`, because the
 * retrieve branch disagreed in one place and the store branch in four.
 */
const leafIssues = (issues: z.ZodIssue[]): z.ZodIssue[] => {
  const out: z.ZodIssue[] = [];
  for (const issue of issues) {
    const unionErrors = (issue as { unionErrors?: z.ZodError[] }).unionErrors;
    if (
      issue.code === z.ZodIssueCode.invalid_union &&
      Array.isArray(unionErrors) &&
      unionErrors.length > 0
    ) {
      const disagreesOnDiscriminator = (branch: z.ZodError): boolean =>
        branch.issues.some(
          (branchIssue) =>
            branchIssue.code === z.ZodIssueCode.invalid_literal ||
            branchIssue.code === z.ZodIssueCode.invalid_enum_value
        );
      const onTopic = unionErrors.filter(
        (branch) => !disagreesOnDiscriminator(branch)
      );
      const pool = onTopic.length > 0 ? onTopic : unionErrors;
      const nearest = pool.reduce((best, candidate) =>
        candidate.issues.length < best.issues.length ? candidate : best
      );
      out.push(...leafIssues(nearest.issues));
      continue;
    }
    out.push(issue);
  }
  return out;
};

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
      // zod v3 exposes issues as `.errors`; zod v4 renamed it to `.issues`.
      // Read both and fall back to an empty list so a version skew can never
      // crash here with "Cannot read properties of undefined (reading 'map')".
      const issues = (error.issues ??
        (error as { errors?: z.ZodIssue[] }).errors ??
        []) as z.ZodIssue[];
      // Format Zod validation errors into a user-friendly message. Union
      // failures are flattened first, and identical lines are collapsed: an
      // intersection of a derived schema with a branch list reports the same
      // missing field once per side.
      const seen = new Set<string>();
      const errorMessages = leafIssues(issues)
        .map((err: z.ZodIssue) => {
          const path = err.path.join('.');
          return `  - ${path || 'root'}: ${err.message}`;
        })
        .filter((line) => !seen.has(line) && seen.add(line))
        .join('\n');

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
