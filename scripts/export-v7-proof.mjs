/** Export public verification evidence without local workstation paths. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const locations = new Map([
  ['runtime', '<runtime-directory>'],
  ['root', '<installed-package-directory>'],
  ['launch', '<plugin-launcher>'],
  ['work', '<verification-workspace>'],
]);

export function redactV7Proof(value) {
  if (Array.isArray(value)) return value.map(redactV7Proof);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    locations.has(key) && typeof entry === 'string'
      ? locations.get(key)
      : redactV7Proof(entry),
  ]));
}

export function writeV7Proof(file, proof) {
  writeFileSync(file, `${JSON.stringify(redactV7Proof(proof), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node scripts/export-v7-proof.mjs <private-proof.json> <public-proof.json>');
  writeV7Proof(output, JSON.parse(readFileSync(input, 'utf8')));
}
