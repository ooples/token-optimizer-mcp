import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { audit } from './audit.mjs';

const target = process.argv[2];
if (!['alpha', 'beta'].includes(target)) {
  console.error('Usage: npm test -- <alpha|beta>');
  process.exit(2);
}

const state = JSON.parse(readFileSync(join(process.cwd(), 'src', `${target}.json`), 'utf8'));
const passed = state.state === 'ready';
audit({ kind: 'supported-verification', target, passed });
if (!passed) {
  console.error(`${target} is not ready`);
  process.exit(1);
}
console.log(`PASS: ${target} was exercised through the supported package test`);
