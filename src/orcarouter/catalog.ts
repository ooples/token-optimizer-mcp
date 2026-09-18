/**
 * The model catalog behind every OrcaRouter model control in this package.
 *
 * ONE SOURCE OF TRUTH, AND IT IS THE LIVE ONE. `GET {apiBase}/models` on the configured OrcaRouter
 * origin is authoritative whenever it answers. What ships in this file is a five-entry VERIFIED SEED
 * for a cold start or an outage -- never mixed into a successful live result, because a seed blended
 * into a live catalog is how a model nobody can call ends up in a dropdown.
 *
 * WHY THE FILTERS ARE STRICT AND PER-ENTRY. OrcaRouter routes many providers behind one endpoint, so
 * the catalog contains models that speak different wire formats. A model that does not declare an
 * endpoint type this client can speak, or does not declare the input modality an entry point is about
 * to send, must be absent from that entry point's options rather than present-and-rejected. The rule
 * everywhere below is fail-closed: an undeclared capability is not an assumed capability.
 *
 * NOTHING HERE GUESSES FROM A MODEL NAME. `gpt-` does not imply reasoning support, `-vision` does not
 * imply image input, and `-embed` does not imply an embeddings endpoint. The only exception is the
 * seed, whose entries carry metadata verified against the live catalog and are labelled as such.
 *
 * BOUNDED ON PURPOSE. A catalog response is remote input that reaches a dropdown, so the request has
 * a timeout, the body has a byte cap, the array has an item cap, and each item has to match a shape
 * before it is accepted. A hostile or broken endpoint can therefore make discovery fail, which is
 * recoverable, rather than exhaust memory, which is not.
 */

import { buildModelsUrl, type OrcaRouterOrigins } from './endpoints.js';

export const CATALOG_TIMEOUT_MS = 10_000;
export const CATALOG_MAX_BYTES = 2 * 1024 * 1024;
export const CATALOG_MAX_ITEMS = 500;

/**
 * The endpoint types this client can actually speak.
 *
 * The proxy forwards OpenAI- and Anthropic-shaped requests, and the summarizer adapter speaks the
 * OpenAI chat dialect, so a text model is usable when it declares any of these. `openai-response` is
 * included because the Responses dialect is a supported client mode here.
 */
export const TEXT_ENDPOINT_TYPES = [
  'openai',
  'anthropic',
  'gemini',
  'openai-response',
] as const;

/** Endpoint types that name a non-text job. Their presence excludes a model from a chat dropdown. */
export const NON_TEXT_ENDPOINT_TYPES = [
  'image-generation',
  'openai-video',
  'jina-rerank',
  'embeddings',
] as const;

export type CatalogCapability =
  | 'chat'
  | 'embedding'
  | 'image'
  | 'video'
  | 'rerank';

export type InputModality = 'text' | 'image' | 'audio' | 'video';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface CatalogModel {
  /** The vendor/model namespace, kept byte-for-byte as the catalog reports it. */
  readonly id: string;
  readonly name: string | null;
  readonly contextLength: number | null;
  readonly supportedEndpointTypes: readonly string[];
  readonly inputModalities: readonly InputModality[];
  readonly reasoningEfforts: readonly ReasoningEffort[];
  /** True when this entry came from the shipped seed rather than a live response. */
  readonly fromSeed: boolean;
}

export type CatalogStatus = 'live' | 'degraded';

export interface CatalogResult {
  readonly status: CatalogStatus;
  /** Why the live catalog was not used, when it was not. Safe to show a user. */
  readonly degradedReason: string | null;
  readonly sourceUrl: string;
  readonly models: readonly CatalogModel[];
}

export interface CatalogRequest {
  readonly capability: CatalogCapability;
  /** For a multimodal entry point: the non-text modality it is actually about to send. */
  readonly requiresInputModality?: InputModality;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * The verified outage seed.
 *
 * SMALL AND LABELLED. These five are the entries the protocol guide names, each carrying the metadata
 * this package uses to filter and to price. `openai/gpt-5.5` keeps the four-step reasoning ladder the
 * guide calls out, because a fallback that restores a model's name while dropping its effort levels
 * is a capability regression that an id-only assertion cannot see.
 */
export const VERIFIED_SEED: readonly CatalogModel[] = Object.freeze([
  Object.freeze({
    id: 'openai/gpt-5.5',
    name: 'GPT-5.5',
    contextLength: 400_000,
    supportedEndpointTypes: Object.freeze([
      'openai',
      'openai-response',
      'anthropic',
    ]),
    inputModalities: Object.freeze(['text', 'image'] as InputModality[]),
    reasoningEfforts: Object.freeze([
      'low',
      'medium',
      'high',
      'xhigh',
    ] as ReasoningEffort[]),
    fromSeed: true,
  }),
  Object.freeze({
    id: 'anthropic/claude-opus-4.8',
    name: 'Claude Opus 4.8',
    contextLength: 200_000,
    supportedEndpointTypes: Object.freeze(['anthropic', 'openai']),
    inputModalities: Object.freeze(['text', 'image'] as InputModality[]),
    reasoningEfforts: Object.freeze([
      'low',
      'medium',
      'high',
    ] as ReasoningEffort[]),
    fromSeed: true,
  }),
  Object.freeze({
    id: 'google/gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
    contextLength: 1_000_000,
    supportedEndpointTypes: Object.freeze(['gemini', 'openai']),
    inputModalities: Object.freeze([
      'text',
      'image',
      'audio',
      'video',
    ] as InputModality[]),
    reasoningEfforts: Object.freeze([] as ReasoningEffort[]),
    fromSeed: true,
  }),
  Object.freeze({
    id: 'deepseek/deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    contextLength: 1_048_576,
    supportedEndpointTypes: Object.freeze(['openai', 'openai-response']),
    inputModalities: Object.freeze(['text'] as InputModality[]),
    reasoningEfforts: Object.freeze([] as ReasoningEffort[]),
    fromSeed: true,
  }),
  Object.freeze({
    id: 'orcarouter/auto',
    name: 'OrcaRouter Auto',
    contextLength: null,
    supportedEndpointTypes: Object.freeze([
      'openai',
      'openai-response',
      'anthropic',
      'gemini',
    ]),
    inputModalities: Object.freeze(['text', 'image'] as InputModality[]),
    reasoningEfforts: Object.freeze([] as ReasoningEffort[]),
    fromSeed: true,
  }),
]);

const MODALITIES: readonly InputModality[] = [
  'text',
  'image',
  'audio',
  'video',
];
const EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function modalityArray(value: unknown): InputModality[] {
  return stringArray(value).filter((item): item is InputModality =>
    (MODALITIES as readonly string[]).includes(item)
  );
}

function effortArray(value: unknown): ReasoningEffort[] {
  return stringArray(value).filter((item): item is ReasoningEffort =>
    (EFFORTS as readonly string[]).includes(item)
  );
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

/**
 * Accept one catalog record, or reject it.
 *
 * Rejects rather than repairs: a record whose `id` is missing cannot be selected, and inventing one
 * would put a name in the dropdown that no request can use.
 */
export function parseCatalogModel(raw: unknown): CatalogModel | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return null;
  const architecture =
    record.architecture && typeof record.architecture === 'object'
      ? (record.architecture as Record<string, unknown>)
      : {};
  const reasoning =
    record.reasoning && typeof record.reasoning === 'object'
      ? (record.reasoning as Record<string, unknown>)
      : {};
  return {
    id,
    name: typeof record.name === 'string' ? record.name : null,
    contextLength:
      positiveInt(record.context_length) ?? positiveInt(record.context_window),
    supportedEndpointTypes: stringArray(record.supported_endpoint_types),
    inputModalities: modalityArray(architecture.input_modalities),
    reasoningEfforts: effortArray(
      reasoning.efforts ?? reasoning.effort_levels ?? record.reasoning_efforts
    ),
    fromSeed: false,
  };
}

/** Does this model declare an endpoint type a text request can be sent to? */
export function speaksText(model: CatalogModel): boolean {
  const declared = new Set(model.supportedEndpointTypes);
  if (
    (NON_TEXT_ENDPOINT_TYPES as readonly string[]).some((t) => declared.has(t))
  )
    return false;
  return (TEXT_ENDPOINT_TYPES as readonly string[]).some((t) =>
    declared.has(t)
  );
}

/**
 * Is this model usable by the given entry point?
 *
 * The `requiresInputModality` branch is the fail-closed one: a chat model with no `architecture`
 * block at all is excluded from a multimodal dropdown, because "did not say" and "said yes" are not
 * the same claim and only one of them can be relied on before sending an image.
 */
export function isCompatible(
  model: CatalogModel,
  request: Pick<CatalogRequest, 'capability' | 'requiresInputModality'>
): boolean {
  const declared = new Set(model.supportedEndpointTypes);
  switch (request.capability) {
    case 'chat': {
      if (!speaksText(model)) return false;
      if (!request.requiresInputModality) return true;
      const modality = request.requiresInputModality;
      if (modality === 'text') return true;
      return model.inputModalities.includes(modality);
    }
    case 'embedding':
      return declared.has('embeddings');
    case 'image':
      return declared.has('image-generation');
    case 'video':
      return declared.has('openai-video');
    case 'rerank':
      return declared.has('jina-rerank');
    default:
      return false;
  }
}

export function filterCatalog(
  models: readonly CatalogModel[],
  request: Pick<CatalogRequest, 'capability' | 'requiresInputModality'>
): CatalogModel[] {
  return models.filter((model) => isCompatible(model, request));
}

/**
 * The `?capability=` value sent upstream, when the protocol defines one for the job.
 *
 * Video and rerank have no documented capability value, so they are filtered client-side against the
 * endpoint type instead of asking the server for something it may not understand.
 */
function capabilityQuery(capability: CatalogCapability): string | undefined {
  if (
    capability === 'chat' ||
    capability === 'embedding' ||
    capability === 'image'
  )
    return capability;
  return undefined;
}

/**
 * Fetch the catalog, or fall back to the seed.
 *
 * The fallback is never silent: `status` and `degradedReason` travel with the models so the UI can
 * say it is showing a reduced list, and a caller can refuse to treat a seed as authoritative.
 */
export async function fetchCatalog(
  origins: OrcaRouterOrigins,
  apiKey: string | null,
  request: CatalogRequest
): Promise<CatalogResult> {
  const url = buildModelsUrl(origins, capabilityQuery(request.capability));
  try {
    const models = await fetchLiveCatalog(url, apiKey, request);
    return {
      status: 'live',
      degradedReason: null,
      sourceUrl: url,
      models: filterCatalog(models, request),
    };
  } catch (error) {
    return {
      status: 'degraded',
      degradedReason: describeFailure(error),
      sourceUrl: url,
      models: filterCatalog(VERIFIED_SEED, request),
    };
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof CatalogError) return error.message;
  if (error instanceof Error && error.name === 'AbortError')
    return 'The model catalog request timed out.';
  return 'The model catalog could not be reached.';
}

export class CatalogError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

async function fetchLiveCatalog(
  url: string,
  apiKey: string | null,
  request: CatalogRequest
): Promise<CatalogModel[]> {
  const controller = new AbortController();
  const timeoutMs = request.timeoutMs ?? CATALOG_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = (): void => controller.abort();
  request.signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    const response = await (request.fetchImpl ?? fetch)(url, {
      method: 'GET',
      headers: apiKey
        ? { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
        : { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new CatalogError(
        response.status === 401
          ? 'OrcaRouter rejected the stored key when listing models. Reconnect to continue.'
          : `The model catalog answered HTTP ${response.status}.`
      );
    }
    const text = await readBounded(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CatalogError(
        'The model catalog answered with unreadable JSON.'
      );
    }
    const data =
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { data?: unknown }).data)
        ? (parsed as { data: unknown[] }).data
        : null;
    if (!data) {
      throw new CatalogError(
        'The model catalog answered in an unrecognised shape.'
      );
    }
    const models: CatalogModel[] = [];
    for (const item of data.slice(0, CATALOG_MAX_ITEMS)) {
      const model = parseCatalogModel(item);
      if (model) models.push(model);
    }
    return models;
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** Read the body with a byte ceiling, so a huge or endless response cannot be buffered. */
async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > CATALOG_MAX_BYTES) {
    throw new CatalogError('The model catalog response was too large to read.');
  }
  const body = response.body;
  if (!body) return response.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > CATALOG_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new CatalogError(
        'The model catalog response was too large to read.'
      );
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Keep a previously selected model id only while it is still offered.
 *
 * A stored selection is not a promise: a provider switch, an added attachment or a changed task can
 * invalidate it, and silently keeping the old value sends a request the user did not choose. The
 * caller clears the control when this returns null.
 */
export function reconcileSelection(
  selectedId: string | null,
  options: readonly CatalogModel[]
): CatalogModel | null {
  if (!selectedId) return null;
  return options.find((model) => model.id === selectedId) ?? null;
}
