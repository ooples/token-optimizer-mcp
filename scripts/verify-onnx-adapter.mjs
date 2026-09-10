/**
 * Proves the ONNX adapter against real onnxruntime inference.
 *
 * WHY THIS IS NOT A JEST TEST, which is the first thing a reader will ask.
 * `onnxruntime-node` builds its output tensor inside native code and checks
 * `data instanceof Float32Array`. Jest runs each suite in its own VM context
 * with its own copy of the global typed arrays, so that check fails against a
 * realm the native module never saw:
 *
 *     TypeError: A float32 tensor's data must be type of function Float32Array()
 *       at new Tensor (onnxruntime-common/lib/tensor-impl.ts:272)
 *
 * The failure is jest's realm boundary, not the adapter, and it happens before
 * any of this package's code runs -- so there is nothing to fix on our side and
 * nothing useful a mock would prove. The adapter tests in
 * `tests/unit/compress/embedding.test.ts` are therefore skipped, and this
 * script is what actually verifies them. Everything that does NOT cross into
 * native code -- the two-phase pass, the cache, the ranker, the fallbacks -- is
 * covered by jest in the ordinary way.
 *
 * Run:  npm run build && node scripts/verify-onnx-adapter.mjs
 * Exits non-zero on any failure, so CI can gate on it.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const MODEL = join(process.cwd(), 'tests', 'fixtures', 'tiny-encoder.onnx');
const DIMENSIONS = 8;

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
}

async function main() {
  console.log('\nONNX adapter, against real onnxruntime inference\n');

  if (!existsSync(MODEL)) {
    console.log(`  SKIP  no fixture at ${MODEL}`);
    console.log('        regenerate with: python tests/fixtures/make-tiny-encoder.py');
    return;
  }
  try {
    await import('onnxruntime-node');
  } catch {
    console.log('  SKIP  onnxruntime-node is not installed (it is an optional dependency)');
    console.log('        install with: npm install --no-save onnxruntime-node');
    return;
  }

  const { onnxEncoder, hashingTokenizer } = await import('../dist/compress/onnx.js');
  const { embeddingCache, warmEmbeddings, semanticRanker } = await import(
    '../dist/compress/embedding.js'
  );

  const encoder = await onnxEncoder({
    modelPath: MODEL,
    dimensions: DIMENSIONS,
    tokenize: hashingTokenizer(64),
  });

  // ---- real inference, real shapes
  const vectors = await encoder.encode([
    'connection pool exhausted',
    'the build finished cleanly',
  ]);
  check('returns one vector per input', vectors.length === 2, `got ${vectors.length}`);
  check('vectors are Float32Array', vectors.every((v) => v instanceof Float32Array));
  check(
    'vectors have the declared width',
    vectors.every((v) => v.length === DIMENSIONS),
    `got ${vectors.map((v) => v.length).join(',')}`
  );
  check(
    'different text gives different vectors',
    JSON.stringify([...vectors[0]]) !== JSON.stringify([...vectors[1]])
  );

  // ---- determinism, which the whole cache-stability argument rests on
  const [a] = await encoder.encode(['connection pool exhausted']);
  const [b] = await encoder.encode(['connection pool exhausted']);
  check('same text gives the same vector', JSON.stringify([...a]) === JSON.stringify([...b]));

  // ---- the buffer-reuse hazard
  //
  // The runtime owns the output buffer and may reuse it on the next run. A
  // subarray view would be silently rewritten while the cache still held it,
  // which is why the adapter copies.
  const [held] = await encoder.encode(['connection pool exhausted']);
  const before = JSON.stringify([...held]);
  await encoder.encode(['something entirely different, to reuse the output buffer']);
  check('an earlier vector survives a later run', JSON.stringify([...held]) === before);

  // ---- batching across the configured batch size
  const many = Array.from({ length: 70 }, (_, i) => `log line number ${i} about the pool`);
  const batched = await encoder.encode(many);
  check('batches larger than batchSize round-trip', batched.length === many.length,
    `got ${batched.length}`);

  // ---- the two-phase path end to end
  const cache = embeddingCache();
  const question = 'why did the database run out of handles';
  const units = [
    'connection pool exhausted on worker seven',
    'the deploy pipeline uploaded the artifact',
  ];
  const stored = await warmEmbeddings(encoder, [question, ...units], cache);
  check('warmEmbeddings populates the cache', stored === 3, `stored ${stored}`);

  const ranked = semanticRanker(question, cache).top(units, 1);
  check('the synchronous ranker reads the warmed cache', ranked.size === 1);

  console.log(
    failures === 0
      ? '\nAll adapter checks passed against real inference.\n'
      : `\n${failures} adapter check(s) FAILED.\n`
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('\nverification threw:', error);
  process.exitCode = 1;
});
