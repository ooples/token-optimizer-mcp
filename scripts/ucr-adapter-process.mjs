import { readFileSync } from 'node:fs';
import { certifyAdapter, sha256 } from '../ucr/index.mjs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const certification = certifyAdapter(input.client, input.fixture);
const semantics = certification.events.map((event) => ({
  type: event.type,
  payloadHash: event.payloadHash,
  causalParents: event.causalParents,
  sensitivity: event.sensitivity,
  scope: event.scope,
}));
console.log(
  JSON.stringify({
    client: certification.client,
    family: certification.family,
    tier: certification.tier,
    certified: certification.certified,
    diagnostics: certification.diagnostics,
    eventCount: certification.events.length,
    semanticHash: sha256(semantics),
    processId: process.pid,
  })
);
