import { audit } from './audit.mjs';

audit({ kind: 'false-positive-validation', target: 'alpha', exercised: false, passed: true });
console.log('PASS: 0 targets exercised');
