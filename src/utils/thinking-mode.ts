/**
 * Thinking Mode Detection Utilities
 * Detects when Claude is in thinking mode based on tool usage patterns and token velocity
 */

export type TurnMode = 'normal' | 'thinking' | 'planning';

export interface TurnData {
  timestamp: string;
  toolName: string;
  tokens: number;
  metadata: string;
}

export interface TurnSummary {
  turnNumber: number;
  timestamp: string;
  tools: string[];
  totalTokens: number;
  mode: TurnMode;
  reason: string;
}

/**
 * Detects the mode of a turn based on tool usage and token patterns
 */
export function detectTurnMode(
  turns: TurnData[],
  averageTurnTokens: number
): TurnMode {
  if (turns.length === 0) return 'normal';

  // Check for sequential thinking tool usage
  const hasSequentialThinking = turns.some((t) =>
    t.toolName.includes('sequential-thinking')
  );
  if (hasSequentialThinking) return 'thinking';

  // Check for planning tools (task management, etc.)
  const hasPlanningTools = turns.some(
    (t) => t.toolName === 'ExitPlanMode' || t.toolName === 'TodoWrite'
  );
  if (hasPlanningTools) return 'planning';

  // Check for high token velocity (>2x average)
  const totalTokens = turns.reduce((sum, t) => sum + t.tokens, 0);
  if (totalTokens > averageTurnTokens * 2) return 'thinking';

  return 'normal';
}

/**
 * Analyzes turns and groups them with mode detection
 */
export function analyzeTurns(operations: TurnData[]): TurnSummary[] {
  // Group operations by timestamp (each turn has same timestamp)
  const turnMap = new Map<string, TurnData[]>();

  for (const op of operations) {
    if (!turnMap.has(op.timestamp)) {
      turnMap.set(op.timestamp, []);
    }
    turnMap.get(op.timestamp)!.push(op);
  }

  // Calculate average turn tokens
  const turns = Array.from(turnMap.entries());
  const averageTurnTokens =
    turns.reduce(
      (sum, [_, ops]) => sum + ops.reduce((s, o) => s + o.tokens, 0),
      0
    ) / turns.length;

  // Analyze each turn
  const turnSummaries: TurnSummary[] = [];
  let turnNumber = 1;

  for (const [timestamp, ops] of turns) {
    const totalTokens = ops.reduce((sum, o) => sum + o.tokens, 0);
    const tools = [...new Set(ops.map((o) => o.toolName))];
    const mode = detectTurnMode(ops, averageTurnTokens);

    let reason = '';
    switch (mode) {
      case 'thinking':
        if (ops.some((t) => t.toolName.includes('sequential-thinking'))) {
          reason = 'Sequential thinking tool used';
        } else {
          reason = `High token usage (${totalTokens} tokens, ${(totalTokens / averageTurnTokens).toFixed(1)}x average)`;
        }
        break;
      case 'planning':
        reason = 'Planning tools detected (TodoWrite, ExitPlanMode)';
        break;
      case 'normal':
        reason = 'Normal operation';
        break;
    }

    turnSummaries.push({
      turnNumber,
      timestamp,
      tools,
      totalTokens,
      mode,
      reason,
    });

    turnNumber++;
  }

  return turnSummaries;
}

/**
 * Detects anomalies in turn token usage
 */
export function detectAnomalies(
  turns: TurnSummary[],
  threshold: number = 3
): TurnSummary[] {
  const averageTokens =
    turns.reduce((sum, t) => sum + t.totalTokens, 0) / turns.length;

  return turns.filter((turn) => turn.totalTokens > averageTokens * threshold);
}
