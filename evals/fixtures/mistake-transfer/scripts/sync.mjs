import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { audit } from './audit.mjs';

const check = process.argv.includes('--check');
let synchronized = true;
for (const target of ['alpha', 'beta']) {
  const sourcePath = join(process.cwd(), 'source', `${target}-policy.txt`);
  const generatedPath = join(process.cwd(), 'clients', target, 'policy.txt');
  const source = readFileSync(sourcePath, 'utf8');
  const generated = readFileSync(generatedPath, 'utf8');
  if (source !== generated) {
    synchronized = false;
    if (!check) writeFileSync(generatedPath, source);
    else console.error(`${generatedPath} differs from source/${target}-policy.txt`);
  }
}
audit({ kind: check ? 'sync-check' : 'sync-write', synchronized: check ? synchronized : true });
if (check && !synchronized) process.exit(1);
console.log(check ? 'PASS: generated policies are synchronized' : 'Generated policies refreshed');
