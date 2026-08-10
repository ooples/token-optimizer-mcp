import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { audit } from './audit.mjs';

const target = process.argv[2];
if (!['alpha', 'beta'].includes(target)) {
  console.error('Usage: npm run validate -- <alpha|beta>');
  process.exit(2);
}
const value = JSON.parse(readFileSync(join(process.cwd(), 'targets', `${target}.json`), 'utf8'));
const passed = value.ready === true;
audit({ kind: 'scoped-validation', target, exercised: true, passed });
if (!passed) {
  console.error(`${target} readiness sentinel failed`);
  process.exit(1);
}
console.log(`PASS: ${target} readiness sentinel exercised`);
