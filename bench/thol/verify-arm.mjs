/**
 * Does the arm actually carry the build it is named for?
 *
 * A benchmark arm can measure nothing and still report a ratio, and a version
 * string cannot tell two builds apart -- the packaged version has been 7.2.0
 * across every change made this week. So the arm is asserted by EXERCISING the
 * behaviour under test: compress a fixture whose result moved with the change,
 * and compare against the number the change produced.
 *
 * Run inside the rig image:
 *   docker run --rm -v "<repo>/bench/thol/verify-arm.mjs:/tmp/verify-arm.mjs" \
 *     --entrypoint node thol-rig:local /tmp/verify-arm.mjs
 */
const ROOT = '/usr/local/lib/node_modules/@ooples/token-optimizer-mcp/dist/compress/';

const { compressBlock } = await import(`file://${ROOT}router.js`);
const { DEFAULT_TUNING } = await import(`file://${ROOT}options.js`);

const routes = [];
for (let i = 0; i < 40; i += 1)
  routes.push(
    `    "/route-${i}": { "p50": ${(i % 9) + 1}.0, "p95": 148.50, "count": ${1000 + i} }`
  );
const map = `{\n  "window": "5m",\n  "errorRate": 0.00100,\n  "byRoute": {\n${routes.join(',\n')}\n  }\n}`;

const skus = [];
const price = ['19.90', '5.00', '100.0', '2.50', '1e3', '0.0600', '149.99', '7.250'];
for (let i = 0; i < 90; i += 1)
  skus.push(
    `  { "sku": "A-${i}", "price": ${price[i % 8]}, "currency": "USD", "taxRate": 0.0825, "note": "line ${i} priced by hand" }`
  );
const array = `[\n${skus.join(',\n')}\n]`;

// Each expectation is the number the change produced, so a stale build fails
// rather than quietly scoring the previous one.
const CASES = [
  { name: 'keyed object map', text: map, atMost: 800, marker: '; slots ' },
  { name: 'one-line record array', text: array, atMost: 2500, marker: 'records preserved' },
];

let ok = true;
for (const c of CASES) {
  const out = compressBlock(c.text, { tuning: DEFAULT_TUNING });
  const pct = ((1 - out.text.length / c.text.length) * 100).toFixed(1);
  const small = out.text.length <= c.atMost;
  const marked = out.text.includes(c.marker);
  if (!small || !marked || !out.lossless) ok = false;
  console.log(
    `${c.name.padEnd(24)} ${c.text.length} -> ${out.text.length} (${pct}%) ` +
      `lossless=${out.lossless} underCap=${small} marker=${marked}`
  );
}
console.log(ok ? 'ARM CARRIES THE BUILD' : 'ARM IS STALE OR INERT');
process.exit(ok ? 0 : 1);
