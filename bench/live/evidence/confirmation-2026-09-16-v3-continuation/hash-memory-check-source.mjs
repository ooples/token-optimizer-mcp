import assert from 'node:assert/strict';
// Run from the repository root with node --max-old-space-size=48.
// Prints a new measurement without overwriting archived evidence.
import { readFile } from 'node:fs/promises';
import { hashes } from '../../confirmation-freeze.mjs';
const study = 'bench/live/evidence/confirmation-2026-09-16-v3';
const frozen = JSON.parse(await readFile(`${study}/freeze.json`, 'utf8'));
const binary = Object.keys(frozen.sha256).find((p) => p.endsWith('bin\\codex.exe'));
assert.ok(binary);
let peak = 0;
const sample = () => { peak = Math.max(peak, process.memoryUsage().arrayBuffers); };
const timer = setInterval(sample, 10);
try {
  for (let i = 0; i < 6; i++) {
    const result = await hashes([binary]);
    assert.equal(result[binary], frozen.sha256[binary]);
    sample();
  }
} finally { clearInterval(timer); }
assert.ok(peak < 64 * 1024 * 1024, `Unexpected buffer peak ${peak}`);
const result = { binaryBytes: 298169136, repetitions: 6, sampledPeakArrayBufferBytes: peak,
  digestMatchesOriginalFreeze: true, note: '10 ms sampled array-buffer footprint under a 48 MiB V8 heap cap; not allocation volume.' };
console.log(JSON.stringify(result));
