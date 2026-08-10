import { audit } from './audit.mjs';

audit({ kind: 'unsupported-verification', target: 'beta', passed: false });
console.error('Unsupported direct probe: run the package-level test from the project root.');
process.exit(1);
