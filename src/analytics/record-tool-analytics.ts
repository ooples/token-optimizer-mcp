/**
 * Auto-recording bridge between the MCP tool dispatcher and the AnalyticsManager.
 *
 * Every token-optimizer tool returns its result as a JSON string inside an MCP
 * `content[].text` block. Most optimization tools include a savings triplet
 * (original tokens, optimized tokens, tokens saved) under one of a handful of
 * well-known field names. This module extracts that triplet from a tool result
 * and records it, so the analytics breakdown tools (`get_hook_analytics`,
 * `get_action_analytics`, `get_mcp_server_analytics`, `export_analytics`,
 * `get_optimization_report`) have real data instead of always returning zeros.
 *
 * It is intentionally best-effort: a tool whose result has no recognizable
 * savings triplet is silently skipped, and any parsing/storage error is
 * swallowed so recording can never break a tool call.
 */

import type { AnalyticsManager } from './analytics-manager.js';
import type { HookPhase } from './analytics-types.js';
import { TokenCounter } from '../core/token-counter.js';
import {
  isVerifiedSavingsEntry,
  SAVINGS_MEASUREMENT_SCHEMA_VERSION,
} from './savings-classification.js';
import { createHash, randomUUID } from 'node:crypto';
import { measureDisplacedInput } from './displaced-input.js';

/** MCP tool result shape (the parts we read). */
interface McpToolResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

const resultTokenCounter = new TokenCounter();

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A normalized savings measurement extracted from a tool result. */
export interface SavingsTriplet {
  originalTokens: number;
  optimizedTokens: number;
  tokensSaved: number;
}

const VALID_HOOK_PHASES: readonly HookPhase[] = [
  'PreToolUse',
  'PostToolUse',
  'SessionStart',
  'PreCompact',
  'UserPromptSubmit',
  'Unknown',
];

// Field-name aliases seen across the 70+ tools. Order matters: the first present
// numeric field wins.
const ORIGINAL_KEYS = [
  'originalTokens',
  'originalTokenCount',
  'tokensBefore',
  'beforeTokens',
  'inputTokens',
];
const OPTIMIZED_KEYS = [
  'optimizedTokens',
  'compressedTokens',
  'cachedTokens',
  'tokensAfter',
  'afterTokens',
  'outputTokens',
];
const SAVED_KEYS = [
  'tokensSaved',
  'savedTokens',
  'tokens_saved',
  'tokenSavings',
];

// Containers a triplet is commonly nested inside.
const NESTED_CONTAINERS = [
  'metadata',
  'stats',
  'statistics',
  'summary',
  'optimization',
  'tokenAnalysis',
  'tokens',
  'result',
  'data',
];

function firstNumber(
  obj: Record<string, unknown>,
  keys: string[]
): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Try to read a savings triplet directly off one object (no recursion). */
function tripletFrom(obj: Record<string, unknown>): SavingsTriplet | null {
  const original = firstNumber(obj, ORIGINAL_KEYS);
  const optimized = firstNumber(obj, OPTIMIZED_KEYS);
  const saved = firstNumber(obj, SAVED_KEYS);

  // Need enough to reconstruct the triplet. Accept any two of the three, or
  // (original + saved) / (original + optimized) / (optimized + saved).
  const known = [original, optimized, saved].filter(
    (n): n is number => typeof n === 'number'
  ).length;
  if (known < 2) {
    // Special case: an explicit savings value alone is still meaningful.
    if (typeof saved === 'number' && typeof original === 'number') {
      // handled below; unreachable here since that's 2 known
    }
    return null;
  }

  let o = original;
  let opt = optimized;
  let s = saved;

  if (o === undefined && opt !== undefined && s !== undefined) o = opt + s;
  if (opt === undefined && o !== undefined && s !== undefined) opt = o - s;
  if (s === undefined && o !== undefined && opt !== undefined) s = o - opt;

  if (o === undefined || opt === undefined || s === undefined) return null;

  // Sanity: no negative token counts; ignore no-op records with nothing saved
  // AND nothing measured (pure noise), but keep genuine 0-savings measurements.
  if (o < 0 || opt < 0) return null;
  if (o === 0 && opt === 0) return null;

  return { originalTokens: o, optimizedTokens: opt, tokensSaved: s };
}

/**
 * Extract a savings triplet from a parsed tool-result payload, checking the
 * top level first, then one level of common nested containers.
 */
export function extractSavings(payload: unknown): SavingsTriplet | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;

  const top = tripletFrom(obj);
  if (top) return top;

  for (const key of NESTED_CONTAINERS) {
    const child = obj[key];
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      const nested = tripletFrom(child as Record<string, unknown>);
      if (nested) return nested;
    }
  }
  return null;
}

/** Resolve the current hook phase from the environment (set by hook launchers). */
export function currentHookPhase(): HookPhase {
  const raw = process.env.TOKEN_OPTIMIZER_HOOK_PHASE;
  if (raw && (VALID_HOOK_PHASES as readonly string[]).includes(raw)) {
    return raw as HookPhase;
  }
  return 'Unknown';
}

/**
 * Best-effort: record the savings from a single MCP tool result. Never throws.
 *
 * @param manager   the shared AnalyticsManager
 * @param toolName  the tool that produced the result (e.g. "smart_read")
 * @param result    the MCP result object returned by the tool handler
 */
export async function recordToolAnalytics(
  manager: AnalyticsManager,
  toolName: string,
  result: McpToolResult,
  attribution: {
    client?: string | null;
    clientVersion?: string | null;
    model?: string | null;
    modelVersion?: string | null;
    /**
     * Where `model` came from -- declared by the operator, observed in the
     * client's own session log, or nowhere. A priced saving is only as good as
     * its model id, so the id and its provenance travel together: without this
     * an unattributed row and a mis-attributed one read identically.
     */
    modelSource?: string | null;
    operationId?: string | null;
  } = {},
  baselineResult: McpToolResult | null = null,
  /**
   * The arguments the caller passed. They name the files this call read on the
   * caller's behalf, which is the one baseline the recorder could never see:
   * what reading them yourself would have cost. Absent, the row records only
   * what it can measure, as before.
   */
  callArguments: unknown = null
): Promise<void> {
  try {
    if (!result || result.isError) return;
    const text = (result.content || [])
      .filter((content) => typeof content?.text === 'string')
      .map((content) => content.text || '')
      .join('\n');
    if (!text) return;

    let payload: unknown = null;
    try {
      payload = JSON.parse(text);
    } catch {
      // Plain text still has a directly measurable returned-context cost.
    }

    // Don't record failures the tool reported in-band.
    if (
      payload &&
      typeof payload === 'object' &&
      (payload as Record<string, unknown>).success === false
    ) {
      return;
    }

    let baselinePayload: unknown = payload;
    let baselineText: string | null = null;
    if (baselineResult) {
      baselineText = (baselineResult.content || [])
        .filter((content) => typeof content?.text === 'string')
        .map((content) => content.text || '')
        .join('\n');
      try {
        baselinePayload = JSON.parse(baselineText);
      } catch {
        baselinePayload = null;
      }
    }
    // Tool-reported fields are retained as an audit trail, never promoted to a
    // verified saving. Across the tool fleet they describe incompatible things
    // (file size, rows scanned, compressed content, or a modeled alternative).
    const reported = extractSavings(baselinePayload);
    const returnedTokens = resultTokenCounter.count(text).tokens;
    const baselineTokens = baselineText
      ? resultTokenCounter.count(baselineText).tokens
      : returnedTokens;
    const baselineBytes = baselineText
      ? Buffer.byteLength(baselineText, 'utf8')
      : Buffer.byteLength(text, 'utf8');
    const returnedBytes = Buffer.byteLength(text, 'utf8');
    const savingsMeasured =
      baselineText !== null &&
      baselineText !== text &&
      baselineTokens > returnedTokens &&
      baselineBytes > returnedBytes;
    /*
     * THE BASELINE ONLY THE CALLER'S ARGUMENTS KNOW, MEASURED HERE.
     *
     * The transport measurement above compares this reply against the same
     * tool's own undisclosed payload, so it can only ever credit what the
     * disclosure layer trimmed. It cannot express the claim the product is
     * actually built on -- that a 300-token answer stood in for reading a
     * 4,937-token file -- because that baseline lives on disk, not in a
     * payload. So it is read and counted here, by the same counter that
     * counted the reply, and the tool's own opinion of the ratio is not
     * consulted at all.
     */
    const displaced = await measureDisplacedInput(callArguments);
    const displacementMeasured =
      !savingsMeasured &&
      displaced !== null &&
      displaced.sha256 !== sha256(text) &&
      displaced.tokens > returnedTokens &&
      displaced.bytes > returnedBytes;

    const originalTokens = savingsMeasured
      ? baselineTokens
      : displacementMeasured && displaced
        ? displaced.tokens
        : returnedTokens;
    const tokensSaved = savingsMeasured
      ? baselineTokens - returnedTokens
      : displacementMeasured && displaced
        ? displaced.tokens - returnedTokens
        : 0;

    const sessionId =
      process.env.TOKEN_OPTIMIZER_SESSION_ID ||
      (payload && typeof payload === 'object'
        ? ((payload as Record<string, unknown>).sessionId as string | undefined)
        : undefined);

    const resultMeta = result._meta?.tokenOptimizer;
    const transportMeta =
      resultMeta && typeof resultMeta === 'object'
        ? (resultMeta as Record<string, unknown>)
        : {};
    const measurementId = attribution.operationId || randomUUID();
    const expansionRef =
      typeof transportMeta.expansionRef === 'string'
        ? transportMeta.expansionRef
        : null;
    let creditedMeasurementId: string | null = null;
    if (expansionRef) {
      const existing = await manager.getEntries();
      const credited = existing.find(
        (entry) =>
          isVerifiedSavingsEntry(entry) &&
          entry.metadata?.disclosureRef === expansionRef &&
          typeof entry.measurementId === 'string'
      );
      creditedMeasurementId = credited?.measurementId || null;
    }

    await manager.track({
      hookPhase: currentHookPhase(),
      toolName,
      mcpServer: 'token-optimizer',
      originalTokens,
      optimizedTokens: returnedTokens,
      tokensSaved,
      savingsMeasured: savingsMeasured || displacementMeasured,
      measurementId,
      ...(sessionId ? { sessionId } : {}),
      ...(attribution.client ? { client: attribution.client } : {}),
      ...(attribution.clientVersion
        ? { clientVersion: attribution.clientVersion }
        : {}),
      ...(attribution.model ? { model: attribution.model } : {}),
      ...(attribution.modelVersion
        ? { modelVersion: attribution.modelVersion }
        : {}),
      metadata: {
        measurementId,
        measurementSchemaVersion: SAVINGS_MEASUREMENT_SCHEMA_VERSION,
        measurement: savingsMeasured
          ? 'materialized-transport-before-after'
          : displacementMeasured
            ? 'measured-input-displacement'
            : expansionRef && creditedMeasurementId
              ? 'actual-expansion-transport-debit'
              : 'actual-return-context-only',
        measurementClass: savingsMeasured
          ? 'verified-transport-reduction'
          : displacementMeasured
            ? 'verified-input-displacement'
            : expansionRef && creditedMeasurementId
              ? 'verified-transport-expansion-debit'
              : 'observed-return-only',
        baselineKind: savingsMeasured
          ? 'materialized-undisclosed-mcp-result'
          : displacementMeasured
            ? 'measured-displaced-input'
            : null,
        baselineBytes:
          displacementMeasured && displaced ? displaced.bytes : baselineBytes,
        returnedBytes,
        bytesSaved: savingsMeasured
          ? baselineBytes - returnedBytes
          : displacementMeasured && displaced
            ? displaced.bytes - returnedBytes
            : 0,
        baselineSha256: baselineText ? sha256(baselineText) : null,
        /*
         * Recorded whenever it could be measured, including on rows the
         * transport class won, so a later audit can see the displacement a row
         * was NOT credited with. Only the class decides what gets summed; two
         * befores for one after are not additive, and labelling both while
         * crediting one is how that stays visible rather than tempting.
         */
        displacedInputTokens: displaced ? displaced.tokens : null,
        displacedInputBytes: displaced ? displaced.bytes : null,
        displacedInputSha256: displaced ? displaced.sha256 : null,
        displacedInputFiles: displaced ? displaced.files : null,
        returnedSha256: sha256(text),
        disclosureRef:
          typeof transportMeta.disclosureRef === 'string'
            ? transportMeta.disclosureRef
            : null,
        expansionRef,
        creditedMeasurementId,
        tokenCountMethod: 'tiktoken-gpt-4-compatible-local-estimate',
        tokenCounterModel: resultTokenCounter.model,
        reportedToolSavings:
          savingsMeasured || displacementMeasured ? null : reported,
        client: attribution.client || 'unattributed',
        clientVersion: attribution.clientVersion || null,
        model: attribution.model || null,
        modelVersion: attribution.modelVersion || null,
        modelSource: attribution.modelSource || 'none',
      },
    });
  } catch {
    // Analytics must never break a tool call.
  }
}
