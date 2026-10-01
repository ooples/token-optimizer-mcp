/**
 * THE OPERATOR PRICE TABLE: a file an operator names, merged into the shipped
 * price catalog with its own provenance label.
 *
 * The shipped catalog only carries models whose price is published somewhere we
 * can cite, which leaves out every self-hosted model, every negotiated
 * enterprise rate and every gateway that prices per customer. The alternative
 * everyone reaches for is a default rate for an unknown model, and that is the
 * one thing this file exists to avoid: a fabricated figure sits in the same
 * column as a measured one and nothing in the report tells them apart. An
 * absent price can be chased; an invented one cannot even be noticed.
 *
 * So an operator supplies the rates instead, and every number they supply is
 * labelled as theirs all the way out to the report. Two rules make that honest:
 * a row that does not parse is REFUSED BY NAME rather than dropped, and the
 * table's own load status travels with the report, so a typo in the path shows
 * up as a named failure instead of as silently missing money.
 */

import { readFileSync, statSync } from 'node:fs';
import type {
  ModelPriceContract,
  NonEmptyTiers,
  PriceCurrency,
  TokenPriceTier,
} from './provider-pricing.js';

/** The environment variable naming the operator's price table. */
export const OPERATOR_PRICE_TABLE_ENV = 'TOKEN_OPTIMIZER_PRICE_TABLE';

/**
 * HOW TO WRITE THE FILE, in the one place an operator will look for it.
 *
 * It sits next to the parser rather than in a document of its own so the two
 * cannot drift: a field renamed below is a field renamed here, in the same
 * edit, and the help text a reader sees is the schema the reader gets.
 */
export const PRICE_TABLE_NOTE = [
  `Prices for models the catalog does not publish: set ${OPERATOR_PRICE_TABLE_ENV}`,
  'to a JSON file of the form',
  '',
  '  { "verifiedAt": "2026-10-01T00:00:00.000Z",',
  '    "models": [ { "route": "self-hosted", "model": "llama-4-70b-local",',
  '                  "uncachedInput": 0.2, "cachedInput": 0.02, "output": 0.6,',
  '                  "cacheWrite": 0.25, "currency": "USD",',
  '                  "aliases": [], "sourceLabel": "our GPU cost" } ] }',
  '',
  'Rates are dollars per million tokens. uncachedInput, cachedInput and output',
  'are required; a write rate left out stays unpriced rather than free, and',
  'cacheWrite5m / cacheWrite1h override cacheWrite where they differ. A row',
  'with "maxInputTokens" also needs "aboveThreshold" stating the rates past it.',
  'Rates from this file win over the shipped catalog and are reported as yours.',
  'A row that does not parse refuses the whole file by name -- nothing is ever',
  'charged at a default rate.',
].join('\n');

export interface OperatorPriceTableStatus {
  /** The path the environment named, or null when it named none. */
  path: string | null;
  /** Contracts this table contributed to the catalog. */
  contracts: number;
  /**
   * Why the table contributed nothing, naming the row and field at fault. Null
   * when there was nothing to load or the whole file loaded.
   */
  error: string | null;
}

const NO_TABLE: OperatorPriceTableStatus = {
  path: null,
  contracts: 0,
  error: null,
};

/** The label every rate from this file wears, wherever it is reported. */
export function operatorSourceLabel(path: string): string {
  return `operator price table (${path})`;
}

function requireNumber(
  row: Record<string, unknown>,
  field: string,
  where: string
): number {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `${where}: "${field}" must be a non-negative number of USD per million tokens`
    );
  }
  return value;
}

function optionalRate(
  row: Record<string, unknown>,
  field: string,
  where: string
): number | null {
  // A MISSING RATE AND A ZERO RATE ARE DIFFERENT FACTS, and the distinction is
  // the whole reason this returns null rather than 0. A route that publishes no
  // cache-write price must fail closed on a request that wrote to cache; a
  // route where the write is genuinely free must charge nothing for it. Writing
  // 0 for "not published" turns a refusal into a free lunch.
  const value = row[field];
  if (value === undefined || value === null) return null;
  return requireNumber(row, field, where);
}

function optionalString(
  row: Record<string, unknown>,
  field: string,
  where: string
): string | undefined {
  const value = row[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${where}: "${field}" must be a non-empty string`);
  }
  return value.trim();
}

function requireString(
  row: Record<string, unknown>,
  field: string,
  where: string
): string {
  const value = optionalString(row, field, where);
  if (value === undefined) {
    throw new Error(`${where}: "${field}" is required`);
  }
  return value;
}

function timestamp(
  row: Record<string, unknown>,
  field: string,
  where: string
): string | undefined {
  const value = optionalString(row, field, where);
  if (value === undefined) return undefined;
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${where}: "${field}" must be an ISO-8601 timestamp`);
  }
  return value;
}

function currencyOf(
  row: Record<string, unknown>,
  where: string
): PriceCurrency {
  const value = optionalString(row, 'currency', where);
  if (value === undefined) return 'USD';
  if (value !== 'USD' && value !== 'CNY') {
    throw new Error(`${where}: "currency" must be one of USD, CNY`);
  }
  return value;
}

function aliasesOf(
  row: Record<string, unknown>,
  where: string
): readonly string[] {
  const value = row.aliases;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${where}: "aliases" must be an array of model ids`);
  }
  return value.map((alias, index) => {
    if (typeof alias !== 'string' || alias.trim() === '') {
      throw new Error(`${where}: "aliases[${index}]" must be a model id`);
    }
    return alias.trim().toLowerCase();
  });
}

function optionalTokenCount(
  row: Record<string, unknown>,
  field: string,
  where: string
): number | null {
  const value = row[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${where}: "${field}" must be a positive whole token count`);
  }
  return value;
}

function tiersOf(row: Record<string, unknown>, where: string): NonEmptyTiers {
  const uncachedInput = requireNumber(row, 'uncachedInput', where);
  const output = requireNumber(row, 'output', where);
  // A read rate is required because a client that reports cached input and a
  // table that omits its price would otherwise bill those tokens at zero.
  const cachedInput = requireNumber(row, 'cachedInput', where);
  const cacheWrite = optionalRate(row, 'cacheWrite', where);
  const standard: TokenPriceTier = {
    uncachedInput,
    cachedInput,
    cacheWrite5m: optionalRate(row, 'cacheWrite5m', where) ?? cacheWrite,
    cacheWrite1h: optionalRate(row, 'cacheWrite1h', where) ?? cacheWrite,
    cacheWrite,
    output,
  };
  const threshold = optionalTokenCount(row, 'maxInputTokens', where);
  if (threshold === null) return [standard];
  // A long-context row states the whole second tier rather than a multiplier:
  // the multipliers differ by vendor (1.5x output at one, 2x at another), and
  // guessing one for a private price list is the same error as guessing a rate.
  const above = row.aboveThreshold;
  if (above === null || typeof above !== 'object' || Array.isArray(above)) {
    throw new Error(
      `${where}: "maxInputTokens" needs an "aboveThreshold" object giving the rates past it`
    );
  }
  const longContext = tiersOf(
    above as Record<string, unknown>,
    `${where} aboveThreshold`
  );
  return [{ ...standard, maxInputTokens: threshold }, ...longContext];
}

function contractsOf(
  parsed: unknown,
  path: string,
  verifiedAt: string
): readonly ModelPriceContract[] {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the file must hold a JSON object with a "models" array');
  }
  const models = (parsed as Record<string, unknown>).models;
  if (!Array.isArray(models)) {
    throw new Error('"models" must be an array of price rows');
  }
  const fileVerifiedAt =
    timestamp(parsed as Record<string, unknown>, 'verifiedAt', 'the file') ??
    verifiedAt;
  const label = operatorSourceLabel(path);
  return models.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`models[${index}]: must be an object`);
    }
    const row = entry as Record<string, unknown>;
    // The row is named by its model wherever it has one, because an index is
    // useless to whoever has to go and fix the file.
    const named = typeof row.model === 'string' ? row.model : `models[${index}]`;
    const where = `models[${index}] (${named})`;
    return {
      provider: optionalString(row, 'provider', where) ?? 'operator',
      route: requireString(row, 'route', where),
      model: requireString(row, 'model', where).toLowerCase(),
      aliases: aliasesOf(row, where),
      currency: currencyOf(row, where),
      verifiedAt:
        timestamp(row, 'verifiedAt', where) ?? fileVerifiedAt,
      effectiveFrom: timestamp(row, 'effectiveFrom', where),
      effectiveTo: timestamp(row, 'effectiveTo', where),
      sourceUrl: optionalString(row, 'sourceUrl', where) ?? path,
      sourceLabel: optionalString(row, 'sourceLabel', where) ?? label,
      tiers: tiersOf(row, where),
    };
  });
}

interface LoadedOperatorPrices {
  readonly contracts: readonly ModelPriceContract[];
  readonly status: OperatorPriceTableStatus;
}

const EMPTY: LoadedOperatorPrices = { contracts: [], status: NO_TABLE };

/**
 * Read the table the environment names. Exported with the path and clock
 * injected so a test drives it without touching the process environment.
 */
export function loadOperatorPrices(
  path: string | null | undefined,
  now: () => string = () => new Date().toISOString()
): LoadedOperatorPrices {
  const named = (path ?? '').trim();
  if (named === '') return EMPTY;
  try {
    // SYNC IS NECESSARY HERE, not convenient: priceTokenUsage is synchronous
    // and is called from hook and report paths that cannot await. The table is
    // read once per process and is an operator-sized file, not a stream.
    // eslint-disable-next-line n/no-sync
    const text = readFileSync(named, 'utf8');
    const contracts = contractsOf(JSON.parse(text), named, now());
    return {
      contracts,
      status: { path: named, contracts: contracts.length, error: null },
    };
  } catch (error) {
    // REFUSED BY NAME, NOT DROPPED. The reason reaches the report so that a
    // typo in the path reads as a named failure rather than as money that
    // quietly went missing. These are paths and field names out of the
    // operator's own file, which is why the message may carry them.
    const reason =
      error instanceof Error ? error.message : 'could not be read';
    return {
      contracts: [],
      status: { path: named, contracts: 0, error: reason },
    };
  }
}

let cached: LoadedOperatorPrices | null = null;
let cachedFor: TableFingerprint | null = null;

/**
 * What the cached table was read from: the path AND the file as it stood.
 *
 * Keying on the path alone is the version of this cache that costs an operator
 * money. They correct a rate, the daemon that has already read the file goes on
 * reporting the old figure, and nothing anywhere says the number is stale --
 * the report looks exactly as it did when it was right. Stamping the mtime and
 * the size into the key makes an edit a cache miss, which is what an edit is.
 */
interface TableFingerprint {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
}

function fingerprint(path: string): TableFingerprint {
  // A STRUCT, NOT A JOINED STRING. Any separator character a key could be
  // built from is a character a path is allowed to contain, so comparing the
  // three parts on their own is the version with no collision to reason about.
  if (path === '') return { path, mtimeMs: 0, size: 0 };
  try {
    // SYNC IS NECESSARY HERE for the same reason the read below is: the whole
    // pricing path is synchronous and is called from hooks that cannot await.
    // eslint-disable-next-line n/no-sync
    const stat = statSync(path);
    return { path, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    // A PATH THAT CANNOT BE STATTED IS STILL CACHEABLE, because the read below
    // fails the same way and the refusal it produces is the answer. The zeroed
    // stamp means a file that later appears stats successfully, which changes
    // the fingerprint and so re-reads.
    return { path, mtimeMs: 0, size: 0 };
  }
}

function sameTable(a: TableFingerprint, b: TableFingerprint): boolean {
  return a.path === b.path && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/**
 * The operator contracts for this process, read once per distinct path.
 *
 * A row here is matched BEFORE the shipped catalog, because an operator who has
 * written down a rate for a model knows something the public page does not --
 * a negotiated discount, a gateway's margin, their own hardware. The label goes
 * with it, so the report still says which of the two priced the request.
 */
export function operatorPriceContracts(
  env: NodeJS.ProcessEnv = process.env
): readonly ModelPriceContract[] {
  return loadedFor(env).contracts;
}

export function operatorPriceTableStatus(
  env: NodeJS.ProcessEnv = process.env
): OperatorPriceTableStatus {
  return loadedFor(env).status;
}

function loadedFor(env: NodeJS.ProcessEnv): LoadedOperatorPrices {
  const path = (env[OPERATOR_PRICE_TABLE_ENV] ?? '').trim();
  const key = fingerprint(path);
  if (cached !== null && cachedFor !== null && sameTable(cachedFor, key)) {
    return cached;
  }
  cached = loadOperatorPrices(path);
  cachedFor = key;
  return cached;
}

/**
 * Forget the cached table. A test that writes a table and then prices against
 * it needs this, and so does an operator who edits the file under a long-lived
 * daemon -- without it the daemon serves the rates it read at boot forever.
 */
export function forgetOperatorPrices(): void {
  cached = null;
  cachedFor = null;
}
