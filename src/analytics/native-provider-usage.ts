import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import {
  inferProviderRoute,
  normalizeUsageDimensions,
  priceTokenUsage,
  type PriceCurrency,
  type PricedTokenUsage,
  type TokenUsageDimensions,
} from './provider-pricing.js';

export interface NativeProviderUsageRecord {
  measurementId: string;
  timestamp: string;
  client: string;
  provider: string;
  billingRoute: string;
  pricingRoute: string;
  model: string | null;
  plan: string | null;
  project: string | null;
  sessionId: string | null;
  usage: TokenUsageDimensions;
  nativeReportedCost: number | null;
  nativeReportedCurrency: PriceCurrency | null;
  source: string;
}

export interface ProviderUsageSummary {
  available: boolean;
  source: string;
  window: {
    days: number;
    since: string | null;
    firstSeen: string | null;
    lastSeen: string | null;
  };
  requestCount: number;
  pricedRequestCount: number;
  unpricedRequestCount: number;
  pricingCoveragePercent: number | null;
  usage: TokenUsageDimensions;
  totalTokens: number;
  apiEquivalentCost: Partial<Record<PriceCurrency, number>>;
  nativeReportedCost: Partial<Record<PriceCurrency, number>>;
  byModel: ProviderUsageGroup[];
  recent: ProviderUsageView[];
}

export interface ProviderUsageGroup {
  client: string;
  provider: string;
  billingRoute: string;
  pricingRoute: string;
  model: string;
  plan: string | null;
  requestCount: number;
  pricedRequestCount: number;
  usage: TokenUsageDimensions;
  totalTokens: number;
  apiEquivalentCost: Partial<Record<PriceCurrency, number>>;
  priceSourceUrl: string | null;
  priceSourceLabel: string;
}

export interface ProviderUsageView extends NativeProviderUsageRecord {
  pricing: PricedTokenUsage;
}

const MAX_FILES_PER_CLIENT = 80;
const DEFAULT_DAYS = 7;
const MAX_TRANSCRIPT_BYTES = Math.max(
  1_000_000,
  Number(process.env.TOKEN_OPTIMIZER_PROVIDER_USAGE_MAX_BYTES) || 512_000_000
);
let liveCache: {
  key: string;
  expiresAt: number;
  report: ProviderUsageSummary;
} | null = null;

function value(record: unknown, key: string): unknown {
  return record && typeof record === 'object'
    ? (record as Record<string, unknown>)[key]
    : undefined;
}

function number(record: unknown, key: string): number {
  const parsed = Number(value(record, key));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function text(record: unknown, key: string): string | null {
  const found = value(record, key);
  return typeof found === 'string' && found.trim() ? found.trim() : null;
}

function usageTotal(usage: TokenUsageDimensions): number {
  return Object.values(usage).reduce((sum, item) => sum + item, 0);
}

function addUsage(
  left: TokenUsageDimensions,
  right: TokenUsageDimensions
): TokenUsageDimensions {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWrite5mInputTokens:
      left.cacheWrite5mInputTokens + right.cacheWrite5mInputTokens,
    cacheWrite1hInputTokens:
      left.cacheWrite1hInputTokens + right.cacheWrite1hInputTokens,
    cacheWriteInputTokens:
      left.cacheWriteInputTokens + right.cacheWriteInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

async function jsonLines(
  filePath: string,
  visit: (parsed: Record<string, unknown>, ordinal: number) => void
): Promise<void> {
  let start: number | undefined;
  try {
    const size = fs.statSync(filePath).size;
    if (size > MAX_TRANSCRIPT_BYTES)
      start = Math.max(0, size - MAX_TRANSCRIPT_BYTES);
  } catch {
    return;
  }
  const input = fs.createReadStream(filePath, { encoding: 'utf8', start });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let ordinal = 0;
  let discardFirstPartialLine = start !== undefined && start > 0;
  for await (const line of lines) {
    ordinal += 1;
    if (discardFirstPartialLine) {
      discardFirstPartialLine = false;
      continue;
    }
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        visit(parsed as Record<string, unknown>, ordinal);
    } catch {
      // A CLI can be terminated while appending its final JSONL line. Earlier
      // complete usage records are still valid and should remain visible.
    }
  }
}

function recentFiles(
  root: string,
  accept: (filePath: string) => boolean,
  sinceMs: number
): string[] {
  if (!fs.existsSync(root)) return [];
  const found: Array<{ filePath: string; mtimeMs: number }> = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(filePath);
      else if (entry.isFile() && accept(filePath)) {
        try {
          const mtimeMs = fs.statSync(filePath).mtimeMs;
          if (mtimeMs >= sinceMs) found.push({ filePath, mtimeMs });
        } catch {
          // A rotated transcript can disappear between enumeration and stat.
        }
      }
    }
  }
  return found
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_FILES_PER_CLIENT)
    .map((item) => item.filePath);
}

function parseHookUsageEvent(
  event: Record<string, unknown>,
  source: string,
  ordinal: number
): NativeProviderUsageRecord | null {
  if (
    !['tool-outcome', 'episode-outcome'].includes(String(value(event, 'kind')))
  )
    return null;
  const measurementId = text(event, 'usageMeasurementId');
  const dimensions = normalizeUsageDimensions({
    uncachedInputTokens: number(event, 'uncachedInputTokens'),
    cachedInputTokens: number(event, 'cachedInputTokens'),
    cacheWrite5mInputTokens: number(event, 'cacheWrite5mInputTokens'),
    cacheWrite1hInputTokens: number(event, 'cacheWrite1hInputTokens'),
    cacheWriteInputTokens: number(event, 'cacheWriteInputTokens'),
    outputTokens: number(event, 'outputTokens'),
  });
  if (!measurementId || usageTotal(dimensions) <= 0) return null;
  const client = String(text(event, 'client') || 'unknown').toLowerCase();
  if (client === 'codex' || client === 'claude-code' || client === 'gemini')
    return null;
  const model = text(event, 'model');
  const inferred = inferProviderRoute(client, model, text(event, 'provider'));
  const at = number(event, 'at');
  return {
    measurementId: `hook:${client}:${measurementId}`,
    timestamp:
      text(event, 'timestamp') ||
      (at > 0 ? new Date(at).toISOString() : new Date().toISOString()),
    client,
    provider: inferred.provider,
    billingRoute: client,
    pricingRoute: inferred.route,
    model,
    plan: text(event, 'plan'),
    project: null,
    sessionId: text(event, 'sessionId'),
    usage: dimensions,
    nativeReportedCost: null,
    nativeReportedCurrency: null,
    source: `${source}:${ordinal}`,
  };
}

async function readHookUsageFile(
  filePath: string
): Promise<NativeProviderUsageRecord[]> {
  const records: NativeProviderUsageRecord[] = [];
  await jsonLines(filePath, (event, ordinal) => {
    const record = parseHookUsageEvent(event, filePath, ordinal);
    if (record) records.push(record);
  });
  return records;
}

function hookEvidenceFiles(home: string, sinceMs: number): string[] {
  const roots = [
    path.join(home, '.token-optimizer', 'wiki'),
    path.join(home, '.token-optimizer', 'unrooted'),
  ];
  const registry = path.join(home, '.token-optimizer', 'projects.jsonl');
  if (fs.existsSync(registry)) {
    try {
      for (const line of fs.readFileSync(registry, 'utf8').split(/\r?\n/)) {
        if (!line) continue;
        const record = JSON.parse(line) as Record<string, unknown>;
        const graphDir = text(record, 'graphDir');
        if (graphDir) roots.push(graphDir);
      }
    } catch {
      // The append-only registry can end with a torn record after a killed hook.
    }
  }
  const unique = new Set<string>();
  for (const root of roots) {
    for (const filePath of recentFiles(
      root,
      (candidate) => path.basename(candidate) === 'evidence.jsonl',
      sinceMs
    ))
      unique.add(filePath);
  }
  return [...unique];
}

export async function readCodexUsageFile(
  filePath: string
): Promise<NativeProviderUsageRecord[]> {
  const output: NativeProviderUsageRecord[] = [];
  const seenCumulative = new Set<string>();
  let sessionId: string | null = null;
  let project: string | null = null;
  let provider = 'openai';
  let model: string | null = null;
  let plan: string | null = null;

  // Tail-bounded reads can begin after session_meta/turn_context. The filename
  // still carries Codex's stable session id, and the current usage event often
  // exposes the model through its rate-limit identity only indirectly. Keep
  // unknown model honest; do not price it until a turn_context is observed.
  const sessionMatch = path
    .basename(filePath)
    .match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
    );
  sessionId = sessionMatch?.[1] || null;

  await jsonLines(filePath, (row, ordinal) => {
    const payload = value(row, 'payload');
    if (value(row, 'type') === 'session_meta') {
      sessionId = text(payload, 'session_id') || text(payload, 'id');
      project = text(payload, 'cwd');
      provider = text(payload, 'model_provider') || provider;
      return;
    }
    if (value(row, 'type') === 'turn_context') {
      model = text(payload, 'model') || model;
      project = text(payload, 'cwd') || project;
      return;
    }
    if (
      value(row, 'type') !== 'event_msg' ||
      value(payload, 'type') !== 'token_count'
    )
      return;

    const info = value(payload, 'info');
    const last = value(info, 'last_token_usage');
    const cumulative = value(info, 'total_token_usage');
    if (!last || typeof last !== 'object') return;
    const fingerprint = JSON.stringify(cumulative || last);
    if (seenCumulative.has(fingerprint)) return;
    seenCumulative.add(fingerprint);

    const limits = value(payload, 'rate_limits');
    plan = text(limits, 'plan_type') || plan;
    const input = number(last, 'input_tokens');
    const cached = number(last, 'cached_input_tokens');
    const writes = number(last, 'cache_write_input_tokens');
    const usage = normalizeUsageDimensions({
      // Codex/OpenAI input_tokens includes cached and cache-write input.
      uncachedInputTokens: Math.max(0, input - cached - writes),
      cachedInputTokens: cached,
      cacheWriteInputTokens: writes,
      outputTokens: number(last, 'output_tokens'),
    });
    output.push({
      measurementId: `codex:${sessionId || path.basename(filePath)}:${fingerprint}`,
      timestamp:
        text(row, 'timestamp') ||
        new Date(fs.statSync(filePath).mtimeMs).toISOString(),
      client: 'codex',
      provider,
      billingRoute: plan ? `codex-${plan}` : 'codex',
      pricingRoute: 'openai-api',
      model,
      plan,
      project,
      sessionId,
      usage,
      nativeReportedCost: null,
      nativeReportedCurrency: null,
      source: `${filePath}:${ordinal}`,
    });
  });
  return output;
}

export async function readClaudeUsageFile(
  filePath: string
): Promise<NativeProviderUsageRecord[]> {
  const byRequest = new Map<string, NativeProviderUsageRecord>();
  await jsonLines(filePath, (row, ordinal) => {
    const message = value(row, 'message');
    const usageRecord = value(message, 'usage');
    if (!usageRecord || typeof usageRecord !== 'object') return;
    const requestId = text(row, 'requestId');
    if (!requestId) return;

    const cacheCreation = value(usageRecord, 'cache_creation');
    const write5m = number(cacheCreation, 'ephemeral_5m_input_tokens');
    const write1h = number(cacheCreation, 'ephemeral_1h_input_tokens');
    const genericWrites = Math.max(
      0,
      number(usageRecord, 'cache_creation_input_tokens') - write5m - write1h
    );
    const nativeCost = Number(
      value(row, 'total_cost_usd') ?? value(row, 'totalCostUsd')
    );
    const candidate: NativeProviderUsageRecord = {
      measurementId: `claude-code:${requestId}`,
      timestamp:
        text(row, 'timestamp') ||
        new Date(fs.statSync(filePath).mtimeMs).toISOString(),
      client: 'claude-code',
      provider: 'anthropic',
      billingRoute: 'claude-code',
      pricingRoute: 'anthropic-api',
      model: text(message, 'model'),
      plan: text(usageRecord, 'service_tier'),
      project: text(row, 'cwd'),
      sessionId: text(row, 'sessionId'),
      usage: normalizeUsageDimensions({
        // Anthropic input_tokens explicitly excludes cache reads and writes.
        uncachedInputTokens: number(usageRecord, 'input_tokens'),
        cachedInputTokens: number(usageRecord, 'cache_read_input_tokens'),
        cacheWrite5mInputTokens: write5m,
        cacheWrite1hInputTokens: write1h,
        cacheWriteInputTokens: genericWrites,
        outputTokens: number(usageRecord, 'output_tokens'),
      }),
      nativeReportedCost:
        Number.isFinite(nativeCost) && nativeCost >= 0 ? nativeCost : null,
      nativeReportedCurrency:
        Number.isFinite(nativeCost) && nativeCost >= 0 ? 'USD' : null,
      source: `${filePath}:${ordinal}`,
    };
    const existing = byRequest.get(requestId);
    if (!existing) {
      byRequest.set(requestId, candidate);
      return;
    }
    // Claude Code writes streaming fragments with the same request id. Input
    // dimensions repeat while output grows, so summing fragments double counts
    // the prompt and keeping the first fragment undercounts the completion.
    byRequest.set(requestId, {
      ...candidate,
      timestamp:
        Date.parse(candidate.timestamp) >= Date.parse(existing.timestamp)
          ? candidate.timestamp
          : existing.timestamp,
      usage: normalizeUsageDimensions({
        uncachedInputTokens: Math.max(
          existing.usage.uncachedInputTokens,
          candidate.usage.uncachedInputTokens
        ),
        cachedInputTokens: Math.max(
          existing.usage.cachedInputTokens,
          candidate.usage.cachedInputTokens
        ),
        cacheWrite5mInputTokens: Math.max(
          existing.usage.cacheWrite5mInputTokens,
          candidate.usage.cacheWrite5mInputTokens
        ),
        cacheWrite1hInputTokens: Math.max(
          existing.usage.cacheWrite1hInputTokens,
          candidate.usage.cacheWrite1hInputTokens
        ),
        cacheWriteInputTokens: Math.max(
          existing.usage.cacheWriteInputTokens,
          candidate.usage.cacheWriteInputTokens
        ),
        outputTokens: Math.max(
          existing.usage.outputTokens,
          candidate.usage.outputTokens
        ),
      }),
      nativeReportedCost:
        candidate.nativeReportedCost ?? existing.nativeReportedCost,
      nativeReportedCurrency:
        candidate.nativeReportedCurrency ?? existing.nativeReportedCurrency,
    });
  });
  return [...byRequest.values()];
}

export function readGeminiUsageFile(
  filePath: string
): NativeProviderUsageRecord[] {
  let root: unknown;
  try {
    root = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return [];
  }
  const sessionId = text(root, 'sessionId');
  const messages = value(root, 'messages');
  if (!Array.isArray(messages)) return [];
  const output: NativeProviderUsageRecord[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const tokens = value(message, 'tokens');
    if (!tokens || typeof tokens !== 'object') continue;
    const input = number(tokens, 'input');
    const cached = number(tokens, 'cached');
    const usage = normalizeUsageDimensions({
      // Gemini prompt/input totals include cached content.
      uncachedInputTokens: Math.max(0, input - cached),
      cachedInputTokens: cached,
      // Gemini output pricing includes generated candidates and thoughts.
      outputTokens: number(tokens, 'output') + number(tokens, 'thoughts'),
    });
    const timestamp =
      text(message, 'timestamp') ||
      text(message, 'time') ||
      text(root, 'lastUpdated') ||
      new Date(fs.statSync(filePath).mtimeMs).toISOString();
    output.push({
      measurementId: `gemini:${sessionId || path.basename(filePath)}:${index}`,
      timestamp,
      client: 'gemini',
      provider: 'google',
      billingRoute: 'gemini-cli',
      pricingRoute: 'gemini-api',
      model: text(message, 'model'),
      plan: null,
      project: null,
      sessionId,
      usage,
      nativeReportedCost: null,
      nativeReportedCurrency: null,
      source: `${filePath}:messages[${index}]`,
    });
  }
  return output;
}

export function nativeUsageRecordFromHookEvent(
  event: Record<string, unknown>,
  source = 'hook-evidence',
  ordinal = 1
): NativeProviderUsageRecord | null {
  return parseHookUsageEvent(event, source, ordinal);
}

export function summarizeProviderUsage(
  records: NativeProviderUsageRecord[],
  recentLimit = 30,
  window: { days?: number; since?: string | null } = {}
): ProviderUsageSummary {
  const unique = new Map(
    records.map((record) => [record.measurementId, record])
  );
  const views = [...unique.values()]
    .map(
      (record): ProviderUsageView => ({
        ...record,
        pricing: priceTokenUsage({
          client: record.client,
          provider: record.provider,
          route: record.pricingRoute,
          model: record.model,
          timestamp: record.timestamp,
          usage: record.usage,
        }),
      })
    )
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const usage = views.reduce(
    (sum, row) => addUsage(sum, row.usage),
    normalizeUsageDimensions()
  );
  const apiEquivalentCost: Partial<Record<PriceCurrency, number>> = {};
  const nativeReportedCost: Partial<Record<PriceCurrency, number>> = {};
  for (const row of views) {
    if (
      row.pricing.available &&
      row.pricing.currency &&
      row.pricing.amount !== null
    )
      apiEquivalentCost[row.pricing.currency] =
        (apiEquivalentCost[row.pricing.currency] || 0) + row.pricing.amount;
    if (row.nativeReportedCurrency && row.nativeReportedCost !== null)
      nativeReportedCost[row.nativeReportedCurrency] =
        (nativeReportedCost[row.nativeReportedCurrency] || 0) +
        row.nativeReportedCost;
  }

  const groups = new Map<string, ProviderUsageView[]>();
  for (const row of views) {
    const key = [
      row.client,
      row.provider,
      row.billingRoute,
      row.pricingRoute,
      row.model || 'model not reported',
      row.plan || '',
    ].join('\u0000');
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  const byModel = [...groups.values()]
    .map((rows): ProviderUsageGroup => {
      const row = rows[0];
      const groupUsage = rows.reduce(
        (sum, item) => addUsage(sum, item.usage),
        normalizeUsageDimensions()
      );
      const costs: Partial<Record<PriceCurrency, number>> = {};
      for (const item of rows) {
        if (
          item.pricing.available &&
          item.pricing.currency &&
          item.pricing.amount !== null
        )
          costs[item.pricing.currency] =
            (costs[item.pricing.currency] || 0) + item.pricing.amount;
      }
      const priced = rows.filter((item) => item.pricing.available);
      return {
        client: row.client,
        provider: row.provider,
        billingRoute: row.billingRoute,
        pricingRoute: row.pricingRoute,
        model: row.model || 'model not reported',
        plan: row.plan,
        requestCount: rows.length,
        pricedRequestCount: priced.length,
        usage: groupUsage,
        totalTokens: usageTotal(groupUsage),
        apiEquivalentCost: costs,
        priceSourceUrl: priced[0]?.pricing.sourceUrl || null,
        priceSourceLabel:
          priced[0]?.pricing.sourceLabel ||
          rows[0].pricing.reason ||
          'No exact price contract',
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);
  const pricedRequestCount = views.filter(
    (row) => row.pricing.available
  ).length;
  return {
    available: views.length > 0,
    source:
      'Native local CLI transcripts; request-deduplicated and priced with exact provider/model/route contracts',
    window: {
      days: Number(window.days) || DEFAULT_DAYS,
      since: window.since || null,
      firstSeen: views.length ? views.at(-1)!.timestamp : null,
      lastSeen: views[0]?.timestamp || null,
    },
    requestCount: views.length,
    pricedRequestCount,
    unpricedRequestCount: views.length - pricedRequestCount,
    pricingCoveragePercent: views.length
      ? (pricedRequestCount / views.length) * 100
      : null,
    usage,
    totalTokens: usageTotal(usage),
    apiEquivalentCost,
    nativeReportedCost,
    byModel,
    recent: views.slice(0, Math.max(1, recentLimit)),
  };
}

export async function readNativeProviderUsage(
  options: {
    days?: number;
    recentLimit?: number;
    homeDirectory?: string;
  } = {}
): Promise<ProviderUsageSummary> {
  const home = options.homeDirectory || os.homedir();
  const days = Math.min(365, Math.max(1, Number(options.days) || DEFAULT_DAYS));
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const cacheKey = `${home}\u0000${days}\u0000${options.recentLimit || 30}`;
  if (
    !options.homeDirectory &&
    liveCache?.key === cacheKey &&
    liveCache.expiresAt > Date.now()
  )
    return liveCache.report;
  const codexFiles = recentFiles(
    path.join(home, '.codex', 'sessions'),
    (filePath) => filePath.endsWith('.jsonl'),
    sinceMs
  );
  const claudeFiles = recentFiles(
    path.join(home, '.claude', 'projects'),
    (filePath) => filePath.endsWith('.jsonl'),
    sinceMs
  );
  const geminiFiles = recentFiles(
    path.join(home, '.gemini', 'tmp'),
    (filePath) => /[\\/]chats[\\/]session.+\.json$/i.test(filePath),
    sinceMs
  );
  const hookFiles = hookEvidenceFiles(home, sinceMs);
  const records = (
    await Promise.all([
      ...codexFiles.map(readCodexUsageFile),
      ...claudeFiles.map(readClaudeUsageFile),
      ...geminiFiles.map(async (filePath) => readGeminiUsageFile(filePath)),
      ...hookFiles.map(readHookUsageFile),
    ])
  )
    .flat()
    .filter((record) => {
      const timestamp = Date.parse(record.timestamp);
      return Number.isFinite(timestamp) && timestamp >= sinceMs;
    });
  const report = summarizeProviderUsage(records, options.recentLimit, {
    days,
    since: new Date(sinceMs).toISOString(),
  });
  if (!options.homeDirectory) {
    const cacheMs = Math.max(
      5_000,
      Number(process.env.TOKEN_OPTIMIZER_PROVIDER_USAGE_CACHE_MS) || 60_000
    );
    liveCache = { key: cacheKey, expiresAt: Date.now() + cacheMs, report };
  }
  return report;
}
