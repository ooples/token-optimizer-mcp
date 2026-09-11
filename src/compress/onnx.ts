/**
 * An ONNX encoder, loaded only if someone asks for one.
 *
 * OPTIONAL IN THE STRICT SENSE: `onnxruntime-node` is not a dependency of this
 * package and is imported dynamically, so a machine without it never sees an
 * error and never pays a byte. Nothing here runs unless a caller supplies a
 * model path.
 *
 * WHY THIS IS FORTY LINES OF GLUE AND NOT A FRAMEWORK. The hard part is not
 * calling onnxruntime -- it is that ranking happens inside synchronous engines
 * and inference is async. `embedding.ts` solves that with a two-phase pass;
 * this file only has to turn text into ids and ids into vectors.
 *
 * THE TOKENIZER IS DELIBERATELY THE CALLER'S PROBLEM. A real sentence encoder
 * needs the exact WordPiece or SentencePiece vocabulary it was trained with,
 * and shipping a guess would produce embeddings that are confidently wrong --
 * the worst failure available here, because the output looks like a working
 * ranking. So `tokenize` is a required argument, and the built-in hashing one
 * is offered only for models that were trained on hashed ids.
 */

import type { SemanticEncoder } from './embedding.js';

/** Turns one string into the token ids the model expects. */
export type OnnxTokenizer = (text: string) => number[];

export interface OnnxEncoderOptions {
  /** Path to the `.onnx` file. */
  readonly modelPath: string;
  /** Vector width the model emits. Validated against the first real output. */
  readonly dimensions: number;
  /** Must match the vocabulary the model was trained with. */
  readonly tokenize: OnnxTokenizer;
  /** Name of the ids input. Defaults to the model's first input. */
  readonly inputName?: string;
  /** Name of the embedding output. Defaults to the model's first output. */
  readonly outputName?: string;
  /** Longest token sequence per text; longer input is truncated. */
  readonly maxTokens?: number;
  /** Texts per `session.run` call. */
  readonly batchSize?: number;
}

const DEFAULT_MAX_TOKENS = 128;
const DEFAULT_BATCH = 32;

/**
 * A tokenizer for models trained on hashed ids, and a trap for everything else.
 *
 * Hashes each word into `[0, vocabSize)`. This is correct ONLY for a model
 * whose training used the same hashing scheme; against a real BERT checkpoint
 * it produces meaningless ids and therefore meaningless vectors, which is why
 * it is not the default and why `tokenize` has no default at all.
 */
export function hashingTokenizer(vocabSize: number): OnnxTokenizer {
  return (text: string): number[] => {
    const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    return words.map((word) => {
      // FNV-1a, for a stable spread that does not need a dependency.
      let hash = 0x811c9dc5;
      for (let i = 0; i < word.length; i += 1) {
        hash ^= word.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return hash % vocabSize;
    });
  };
}

/**
 * Loads a model and returns an encoder over it.
 *
 * Throws if `onnxruntime-node` is absent or the model will not load, because
 * this is called once at startup by a caller who explicitly asked for a model.
 * Failing loudly here is right; failing loudly per-request is not, which is
 * why `warmEmbeddings` swallows everything downstream of this point.
 */
export async function onnxEncoder(
  options: OnnxEncoderOptions
): Promise<SemanticEncoder> {
  const {
    modelPath,
    dimensions,
    tokenize,
    inputName,
    outputName,
    maxTokens = DEFAULT_MAX_TOKENS,
    batchSize = DEFAULT_BATCH,
  } = options;

  if (typeof tokenize !== 'function') {
    throw new TypeError(
      'onnxEncoder needs a tokenize function matching the model vocabulary; ' +
        'a mismatched tokenizer produces confidently wrong embeddings'
    );
  }

  // Dynamic and by name, so a bundler does not try to resolve a package that
  // is deliberately not a dependency.
  const moduleName = 'onnxruntime-node';
  const ort = (await import(moduleName)) as unknown as OnnxRuntime;

  const session = await ort.InferenceSession.create(modelPath);
  const ids = inputName ?? session.inputNames[0];
  const out = outputName ?? session.outputNames[0];

  return {
    dimensions,
    async encode(texts) {
      const vectors: Float32Array[] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        const slice = texts.slice(start, start + batchSize);
        vectors.push(
          ...(await runBatch(
            ort,
            session,
            ids,
            out,
            slice,
            tokenize,
            maxTokens,
            dimensions
          ))
        );
      }
      return vectors;
    },
  };
}

/**
 * One `session.run` over a batch of texts, returning one vector per text.
 *
 * EXPORTED FOR THE GUARDS BELOW, which are the part of this file most worth
 * testing and the part hardest to reach through {@link onnxEncoder}: that path
 * needs `onnxruntime-node` present and a real model that misbehaves in a
 * specific way. Every argument here is structural, so a test can hand it a
 * runtime and a session that return a deliberately wrong shape and assert that
 * the shape is rejected rather than silently mis-sliced.
 */
export async function runBatch(
  ort: OnnxRuntime,
  session: OnnxSession,
  inputName: string,
  outputName: string,
  texts: readonly string[],
  tokenize: OnnxTokenizer,
  maxTokens: number,
  dimensions: number
): Promise<Float32Array[]> {
  // RECTANGULAR AND PADDED, because a tensor has one shape. Padding with id 0
  // is the convention every encoder here would use; a model that gives 0 a
  // meaning needs its own adapter rather than a flag on this one.
  const rows = texts.map((text) => {
    const encoded = tokenize(text).slice(0, maxTokens);
    return encoded.length ? encoded : [0];
  });
  const width = Math.max(...rows.map((row) => row.length));

  const flat = new BigInt64Array(rows.length * width);
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c += 1) {
      flat[r * width + c] = BigInt(row[c]);
    }
  });

  const tensor = new ort.Tensor('int64', flat, [rows.length, width]);
  const result = await session.run({ [inputName]: tensor });
  const embedding = result[outputName];
  if (!embedding) {
    throw new Error(`the model produced no output named '${outputName}'`);
  }

  // THE MODEL'S WIDTH, CHECKED AGAINST THE DECLARED ONE. Slicing on a `dimensions` the
  // model does not share misaligns every row after the first -- and row 0 is still
  // exactly `dimensions` long, so the length check downstream passes and the ranking
  // becomes confidently wrong. That is the worst failure available here: a wrong answer
  // that looks like a right one, which is precisely what this file's header says must
  // never happen quietly.
  const vectorWidth = embedding.dims[embedding.dims.length - 1];
  if (vectorWidth !== dimensions) {
    throw new Error(
      `the model produced ${vectorWidth}-wide vectors but 'dimensions' declares ${dimensions}; ` +
        'every row after the first would be read from the wrong offset'
    );
  }
  // EXACTLY ONE VECTOR PER INPUT, not "at least one". An unpooled model emits
  // [batch, tokens, dimensions]: its last dimension still equals `dimensions`, so the
  // width check above is satisfied, and it produces batch x tokens vectors -- more
  // than there are inputs, which a `<` comparison waves through. The slice loop below
  // then hands row 1 the SECOND TOKEN OF ROW 0 and every ranking built on it is
  // wrong while looking entirely well-formed. A non-integer count means the output is
  // not a whole number of vectors at all, which is the same class of defect.
  const produced = embedding.data.length / dimensions;
  if (!Number.isInteger(produced) || produced !== rows.length) {
    throw new Error(
      `the model produced ${produced} vectors of width ${dimensions} for ${rows.length} ` +
        `inputs (output dims [${embedding.dims.join(', ')}]); it must produce exactly one ` +
        'pooled vector per input'
    );
  }

  const data = embedding.data as Float32Array;
  const out: Float32Array[] = [];
  for (let r = 0; r < rows.length; r += 1) {
    // Copied rather than subarray'd: the runtime owns the backing buffer and
    // may reuse it on the next run, which would silently rewrite vectors the
    // cache is still holding.
    out.push(
      Float32Array.from(data.subarray(r * dimensions, (r + 1) * dimensions))
    );
  }
  return out;
}

// Minimal structural types for the optional dependency, so this file compiles
// with or without `onnxruntime-node` present.
// Exported alongside runBatch so a test can supply them; `declaration: true` would
// otherwise refuse to emit a signature naming types it cannot reference.
export interface OnnxTensorLike {
  readonly data: ArrayLike<number>;
  readonly dims: readonly number[];
}

export interface OnnxSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OnnxTensorLike>>;
}

export interface OnnxRuntime {
  readonly InferenceSession: { create(path: string): Promise<OnnxSession> };
  readonly Tensor: new (
    type: string,
    data: BigInt64Array,
    dims: readonly number[]
  ) => unknown;
}
