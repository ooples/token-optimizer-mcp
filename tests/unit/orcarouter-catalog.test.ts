/**
 * The model catalog and its capability filters.
 *
 * The fixtures below are shaped like real `GET /v1/models` records: a text-only chat model, a chat
 * model that declares image input, an embedding model, an image-generation model, a video model and
 * a rerank model. Each capability filter is asserted against all of them, so a filter that lets the
 * wrong one through fails here rather than in a dropdown.
 *
 * The properties that matter beyond filtering: live discovery is authoritative and the seed is NOT
 * mixed into it, a failed discovery falls back to a labelled seed with its reasoning and modality
 * metadata intact, the response is bounded, and a selection that is no longer compatible is reported
 * as invalid so the caller clears it.
 */

import { describe, it, expect } from '@jest/globals';
import {
  CATALOG_MAX_BYTES,
  CatalogError,
  VERIFIED_SEED,
  fetchCatalog,
  filterCatalog,
  isCompatible,
  parseCatalogModel,
  reconcileSelection,
  speaksText,
  type CatalogModel,
} from '../../src/orcarouter/catalog.js';
import {
  DEFAULT_API_BASE,
  DEFAULT_AUTH_BASE,
} from '../../src/orcarouter/endpoints.js';

const origins = { authBase: DEFAULT_AUTH_BASE, apiBase: DEFAULT_API_BASE };

/** The shape the live endpoint returns, verified against the real one on 2026-09-18. */
const LIVE_RECORDS = [
  {
    id: 'orcarouter/auto',
    object: 'model',
    supported_endpoint_types: [
      'openai',
      'openai-response',
      'anthropic',
      'gemini',
    ],
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    object: 'model',
    supported_endpoint_types: ['openai', 'openai-response'],
    context_length: 1048576,
    architecture: { input_modalities: ['text'], output_modalities: null },
  },
  {
    id: 'deepseek/deepseek-v4.1-flash',
    object: 'model',
    supported_endpoint_types: ['openai', 'openai-response', 'anthropic'],
    context_length: 1048576,
    architecture: {
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
    },
  },
  {
    id: 'openai/gpt-5.5',
    object: 'model',
    supported_endpoint_types: ['openai', 'openai-response', 'anthropic'],
    context_length: 400000,
    architecture: { input_modalities: ['text', 'image'] },
    reasoning: { efforts: ['low', 'medium', 'high', 'xhigh'] },
  },
  {
    id: 'vendor/embed-large',
    object: 'model',
    supported_endpoint_types: ['embeddings'],
  },
  {
    id: 'vendor/image-gen-1',
    object: 'model',
    supported_endpoint_types: ['image-generation'],
  },
  {
    id: 'vendor/video-1',
    object: 'model',
    supported_endpoint_types: ['openai-video'],
  },
  {
    id: 'vendor/rerank-v2',
    object: 'model',
    supported_endpoint_types: ['jina-rerank'],
  },
];

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
) {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: new Headers(init.headers ?? {}),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    body: null,
  } as unknown as Response;
}

function fetchReturning(records: unknown[], status = 200): typeof fetch {
  return (() =>
    Promise.resolve(
      jsonResponse({ data: records }, { status })
    )) as unknown as typeof fetch;
}

const live = LIVE_RECORDS.map((record) => parseCatalogModel(record)!);

describe('catalog parsing', () => {
  it('keeps the vendor/model namespace byte-for-byte and reads the documented metadata', () => {
    const model = parseCatalogModel(LIVE_RECORDS[2]);
    expect(model?.id).toBe('deepseek/deepseek-v4.1-flash');
    expect(model?.contextLength).toBe(1048576);
    expect(model?.supportedEndpointTypes).toEqual([
      'openai',
      'openai-response',
      'anthropic',
    ]);
    expect(model?.inputModalities).toEqual(['text', 'image']);
    expect(model?.fromSeed).toBe(false);
  });

  it('reads the reasoning effort ladder when the catalog declares one', () => {
    const model = parseCatalogModel(LIVE_RECORDS[3]);
    expect(model?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('rejects a record with no usable id rather than inventing one', () => {
    expect(parseCatalogModel({ object: 'model' })).toBeNull();
    expect(parseCatalogModel({ id: '   ' })).toBeNull();
    expect(parseCatalogModel(null)).toBeNull();
    expect(parseCatalogModel('a string')).toBeNull();
  });

  it('fails closed on undeclared modalities and endpoint types', () => {
    const bare = parseCatalogModel({ id: 'vendor/mystery' });
    expect(bare?.inputModalities).toEqual([]);
    expect(bare?.supportedEndpointTypes).toEqual([]);
    expect(speaksText(bare!)).toBe(false);
    expect(isCompatible(bare!, { capability: 'chat' })).toBe(false);
    expect(
      isCompatible(bare!, {
        capability: 'chat',
        requiresInputModality: 'image',
      })
    ).toBe(false);
  });
});

describe('capability filters', () => {
  it('offers only text-capable models for chat, excluding every non-text job', () => {
    const options = filterCatalog(live, { capability: 'chat' });
    const ids = options.map((model) => model.id);
    expect(ids).toContain('orcarouter/auto');
    expect(ids).toContain('deepseek/deepseek-v4-pro');
    expect(ids).toContain('deepseek/deepseek-v4.1-flash');
    expect(ids).toContain('openai/gpt-5.5');
    expect(ids).not.toContain('vendor/embed-large');
    expect(ids).not.toContain('vendor/image-gen-1');
    expect(ids).not.toContain('vendor/video-1');
    expect(ids).not.toContain('vendor/rerank-v2');
  });

  it('keeps only models that explicitly declare image input when an image is being sent', () => {
    const options = filterCatalog(live, {
      capability: 'chat',
      requiresInputModality: 'image',
    });
    expect(options.map((model) => model.id)).toEqual([
      'deepseek/deepseek-v4.1-flash',
      'openai/gpt-5.5',
    ]);
    // The text-only chat model is excluded even though it is a perfectly good chat model.
    expect(options.map((model) => model.id)).not.toContain(
      'deepseek/deepseek-v4-pro'
    );
    for (const model of options) {
      expect(model.inputModalities).toContain('image');
    }
  });

  it('excludes a model that declares no architecture block from a multimodal list', () => {
    const undeclared = parseCatalogModel({
      id: 'vendor/chat-no-arch',
      supported_endpoint_types: ['openai'],
    })!;
    expect(isCompatible(undeclared, { capability: 'chat' })).toBe(true);
    expect(
      isCompatible(undeclared, {
        capability: 'chat',
        requiresInputModality: 'image',
      })
    ).toBe(false);
    expect(
      isCompatible(undeclared, {
        capability: 'chat',
        requiresInputModality: 'audio',
      })
    ).toBe(false);
  });

  it('filters audio and video input by declaration only', () => {
    const audioChat = parseCatalogModel({
      id: 'vendor/audio-chat',
      supported_endpoint_types: ['openai'],
      architecture: { input_modalities: ['text', 'audio'] },
    })!;
    expect(
      isCompatible(audioChat, {
        capability: 'chat',
        requiresInputModality: 'audio',
      })
    ).toBe(true);
    expect(
      isCompatible(audioChat, {
        capability: 'chat',
        requiresInputModality: 'video',
      })
    ).toBe(false);
    expect(
      isCompatible(audioChat, {
        capability: 'chat',
        requiresInputModality: 'image',
      })
    ).toBe(false);
  });

  it('matches embedding, image, video and rerank strictly by endpoint type', () => {
    expect(
      filterCatalog(live, { capability: 'embedding' }).map((m) => m.id)
    ).toEqual(['vendor/embed-large']);
    expect(
      filterCatalog(live, { capability: 'image' }).map((m) => m.id)
    ).toEqual(['vendor/image-gen-1']);
    expect(
      filterCatalog(live, { capability: 'video' }).map((m) => m.id)
    ).toEqual(['vendor/video-1']);
    expect(
      filterCatalog(live, { capability: 'rerank' }).map((m) => m.id)
    ).toEqual(['vendor/rerank-v2']);
  });

  it('never infers a capability from a model name', () => {
    const misleading = parseCatalogModel({
      id: 'vendor/vision-embed-rerank-pro',
      supported_endpoint_types: ['openai'],
      architecture: { input_modalities: ['text'] },
    })!;
    expect(
      filterCatalog([misleading], { capability: 'embedding' })
    ).toHaveLength(0);
    expect(filterCatalog([misleading], { capability: 'rerank' })).toHaveLength(
      0
    );
    expect(
      filterCatalog([misleading], {
        capability: 'chat',
        requiresInputModality: 'image',
      })
    ).toHaveLength(0);
    expect(filterCatalog([misleading], { capability: 'chat' })).toHaveLength(1);
  });
});

describe('live discovery', () => {
  it('uses the configured API origin, sends the key as a Bearer header, and asks for the capability', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        headers: init.headers as Record<string, string>,
      });
      return Promise.resolve(jsonResponse({ data: LIVE_RECORDS }));
    }) as unknown as typeof fetch;

    const result = await fetchCatalog(origins, 'sk-orca-fake', {
      capability: 'chat',
      fetchImpl,
    });

    expect(result.status).toBe('live');
    expect(result.degradedReason).toBeNull();
    expect(calls[0].url).toBe(
      'https://api.orcarouter.ai/v1/models?capability=chat'
    );
    expect(calls[0].headers.Authorization).toBe('Bearer sk-orca-fake');
    // Never the auth origin, and never the wrong path.
    expect(calls[0].url).not.toContain('www.orcarouter.ai');
    expect(calls[0].url).not.toContain('/auth/keys');
  });

  it('is authoritative: no seed entry appears in a successful live result', async () => {
    const result = await fetchCatalog(origins, null, {
      capability: 'chat',
      fetchImpl: fetchReturning([
        { id: 'only/this-one', supported_endpoint_types: ['openai'] },
      ]),
    });
    expect(result.status).toBe('live');
    expect(result.models.map((model) => model.id)).toEqual(['only/this-one']);
    for (const seed of VERIFIED_SEED) {
      expect(result.models.map((model) => model.id)).not.toContain(seed.id);
    }
    expect(result.models.some((model) => model.fromSeed)).toBe(false);
  });

  it('falls back to the labelled seed on a network failure, an HTTP error and a bad body', async () => {
    const failures: Array<typeof fetch> = [
      (() =>
        Promise.reject(
          new TypeError('fetch failed')
        )) as unknown as typeof fetch,
      fetchReturning([], 500),
      (() =>
        Promise.resolve(
          jsonResponse({ nope: true })
        )) as unknown as typeof fetch,
    ];
    for (const fetchImpl of failures) {
      const result = await fetchCatalog(origins, null, {
        capability: 'chat',
        fetchImpl,
      });
      expect(result.status).toBe('degraded');
      expect(typeof result.degradedReason).toBe('string');
      expect(result.models.length).toBeGreaterThan(0);
      expect(result.models.every((model) => model.fromSeed)).toBe(true);
      expect(result.sourceUrl).toBe(
        'https://api.orcarouter.ai/v1/models?capability=chat'
      );
    }
  });

  it('keeps reasoning and modality metadata on the seed, so a fallback is not a downgrade', async () => {
    const result = await fetchCatalog(origins, null, {
      capability: 'chat',
      fetchImpl: (() =>
        Promise.reject(new Error('offline'))) as unknown as typeof fetch,
    });
    const gpt = result.models.find((model) => model.id === 'openai/gpt-5.5');
    expect(gpt?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(gpt?.inputModalities).toContain('image');
    const deepseek = result.models.find(
      (model) => model.id === 'deepseek/deepseek-v4-pro'
    );
    expect(deepseek?.contextLength).toBe(1048576);
    expect(result.models.map((model) => model.id)).toEqual([
      'openai/gpt-5.5',
      'anthropic/claude-opus-4.8',
      'google/gemini-3.5-flash',
      'deepseek/deepseek-v4-pro',
      'orcarouter/auto',
    ]);
  });

  it('filters the seed by the requested capability too, rather than offering all five', async () => {
    const offline = (() =>
      Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    const embeddings = await fetchCatalog(origins, null, {
      capability: 'embedding',
      fetchImpl: offline,
    });
    // None of the verified seed entries is an embedding model, and an empty list is the honest
    // answer rather than a chat model offered to an embeddings control.
    expect(embeddings.status).toBe('degraded');
    expect(embeddings.models).toHaveLength(0);

    const vision = await fetchCatalog(origins, null, {
      capability: 'chat',
      requiresInputModality: 'image',
      fetchImpl: offline,
    });
    expect(vision.models.map((model) => model.id)).toEqual([
      'openai/gpt-5.5',
      'anthropic/claude-opus-4.8',
      'google/gemini-3.5-flash',
      'orcarouter/auto',
    ]);
  });

  it('reports a rejected key as an actionable degraded reason rather than a silent empty list', async () => {
    const result = await fetchCatalog(origins, null, {
      capability: 'chat',
      fetchImpl: fetchReturning([], 401),
    });
    expect(result.status).toBe('degraded');
    expect(result.degradedReason).toMatch(/rejected the stored key/i);
  });

  it('bounds the response size', async () => {
    const huge = (() =>
      Promise.resolve(
        jsonResponse(
          { data: [] },
          { headers: { 'content-length': String(CATALOG_MAX_BYTES + 1) } }
        )
      )) as unknown as typeof fetch;
    const result = await fetchCatalog(origins, null, {
      capability: 'chat',
      fetchImpl: huge,
    });
    expect(result.status).toBe('degraded');
    expect(result.degradedReason).toMatch(/too large/i);
  });

  it('bounds the item count and drops unusable records', async () => {
    const many = Array.from({ length: 900 }, (_, index) => ({
      id: `vendor/model-${index}`,
      supported_endpoint_types: ['openai'],
    }));
    const result = await fetchCatalog(origins, null, {
      capability: 'chat',
      fetchImpl: fetchReturning([...many, { object: 'model' }, null]),
    });
    expect(result.models.length).toBeLessThanOrEqual(500);
    expect(
      result.models.every((model) => model.id.startsWith('vendor/model-'))
    ).toBe(true);
  });

  it('stops at the byte cap even when the response declares no length', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
    let reads = 0;
    const streamed = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: () => {
            reads += 1;
            return Promise.resolve(
              reads > 64 ? { done: true } : { done: false, value: chunk }
            );
          },
          cancel: () => Promise.resolve(),
        }),
      },
      text: () => Promise.resolve(''),
    } as unknown as Response;
    const result = await fetchCatalog(origins, null, {
      capability: 'chat',
      fetchImpl: (() => Promise.resolve(streamed)) as unknown as typeof fetch,
    });
    expect(result.status).toBe('degraded');
    expect(result.degradedReason).toMatch(/too large/i);
  });
});

describe('selection reconciliation', () => {
  it('keeps a selection that is still offered and clears one that is not', () => {
    const options: CatalogModel[] = live.filter((model) =>
      isCompatible(model, { capability: 'chat' })
    );
    expect(reconcileSelection('deepseek/deepseek-v4-pro', options)?.id).toBe(
      'deepseek/deepseek-v4-pro'
    );
    expect(reconcileSelection('vendor/image-gen-1', options)).toBeNull();
    expect(reconcileSelection('vendor/removed-model', options)).toBeNull();
    expect(reconcileSelection(null, options)).toBeNull();
    expect(reconcileSelection('', options)).toBeNull();
  });

  it('invalidates a text model the moment the entry point starts sending an image', () => {
    const textOnly = live.filter(
      (model) => model.id === 'deepseek/deepseek-v4-pro'
    );
    const withImage = filterCatalog(live, {
      capability: 'chat',
      requiresInputModality: 'image',
    });
    expect(reconcileSelection('deepseek/deepseek-v4-pro', textOnly)?.id).toBe(
      'deepseek/deepseek-v4-pro'
    );
    expect(
      reconcileSelection('deepseek/deepseek-v4-pro', withImage)
    ).toBeNull();
  });
});

describe('catalog errors', () => {
  it('names the failure kind so a caller can distinguish unreadable JSON from an outage', () => {
    expect(new CatalogError('x')).toBeInstanceOf(Error);
    expect(new CatalogError('x').name).toBe('CatalogError');
  });
});
