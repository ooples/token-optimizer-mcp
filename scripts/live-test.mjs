import { TokenCounter } from '../dist/core/token-counter.js';
import { CompressionEngine } from '../dist/core/compression-engine.js';

const tc = new TokenCounter();
const ce = new CompressionEngine();

// Highly compressible sample text to demonstrate savings
const text = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(800);
const key = 'demo-cache-key-12345';

const origTokens = tc.count(text).tokens;
const { compressed: compressedB64, compressedSize, percentSaved: bytePercentSaved } = ce.compressToBase64(text, { quality: 11 });
const compBytes = Buffer.byteLength(compressedB64, 'base64');
const keyTokens = tc.count(key).tokens;
const savedIfExternal = origTokens - keyTokens; // externalized storage model
// Round percentage to one decimal place by rounding at 0.1% precision
const PERCENTAGE_PRECISION = 1000; // ratio * 1000 => percent * 10
const percentSaved = origTokens > 0
  ? Math.round((savedIfExternal / origTokens) * PERCENTAGE_PRECISION) / 10
  : 0;

console.log(
  JSON.stringify(
    { origTokens, keyTokens, savedIfExternal, percentSaved, compBytes, bytePercentSaved, compressedSize },
    null,
    2
  )
);
