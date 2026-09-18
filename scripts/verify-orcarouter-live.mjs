#!/usr/bin/env node
/**
 * One live round-trip through the provider code this change adds.
 *
 * WHAT THIS IS FOR. Unit tests use a fake upstream, which proves the shape of a request but not that
 * OrcaRouter answers one. This script goes through the SAME functions the product uses --
 * `resolveProvider`, `discoverModels`, `sendProviderRequest` -- against the real service, so a broken
 * endpoint, a wrong header or a mis-derived base URL fails here rather than in a user's editor.
 *
 * IT IS NOT A CURL. A standalone `curl` that returns 200 says nothing about whether this package's
 * provider path works, because it does not use it. Every request below is built by the shipped code.
 *
 * WHAT IT CHECKS
 *   1. `GET https://api.orcarouter.ai/v1/models?capability=chat` through `discoverModels`, and that
 *      the live result is authoritative -- no seed entry is blended in.
 *   2. A real chat completion through `sendProviderRequest`, with the model chosen FROM that catalog
 *      rather than hardcoded, so the check follows the catalog as it changes.
 *   3. The multimodal filter, when the catalog offers an image-input model at all: those options
 *      must be a strict subset of the chat options, and every one must declare image input.
 *
 * Requires ORCAROUTER_API_KEY. Writes nothing: no credential, no cache, no artifact.
 *
 * Run: ORCAROUTER_API_KEY=… node scripts/verify-orcarouter-live.mjs
 */

import {
  resolveProvider,
  discoverModels,
  sendProviderRequest,
  ORCAROUTER_PROVIDER,
} from '../dist/orcarouter/provider.js';

const apiKey = (process.env.ORCAROUTER_API_KEY || '').trim();
if (!apiKey) {
  console.error('ORCAROUTER_API_KEY is required for the live check.');
  process.exit(1);
}

// Pinned to the documented defaults, not the ambient environment: this check is about the public
// service, so a self-hosted override in the shell must not silently redirect it.
const env = { ...process.env, ORCAROUTER_API_KEY: apiKey };
delete env.ORCA_BASE_URL;
delete env.ORCA_AUTH_BASE_URL;
delete env.ORCA_API_BASE_URL;

const failures = [];
const pass = (name, detail) =>
  console.log(`  PASS  ${name}${detail ? ` -- ${detail}` : ''}`);
const fail = (name, detail) => {
  failures.push(name);
  console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
};

const provider = await resolveProvider(env);
console.log(
  `provider: ${ORCAROUTER_PROVIDER.id} (${ORCAROUTER_PROVIDER.label})`
);
console.log(`api base: ${provider.origins.apiBase}`);
console.log(`auth base: ${provider.origins.authBase}`);

if (
  provider.ready &&
  provider.origins.apiBase === 'https://api.orcarouter.ai/v1'
) {
  pass(
    'provider_resolves',
    `${ORCAROUTER_PROVIDER.id} -> ${provider.origins.apiBase}`
  );
} else {
  fail(
    'provider_resolves',
    `ready=${provider.ready} apiBase=${provider.origins.apiBase}`
  );
}

// --- 1. the live catalog, through the shipped discovery path ---------------
const chat = await discoverModels({ capability: 'chat' }, env);
const ids = chat.models.map((model) => model.id);
console.log(`\nchat catalog: ${chat.status} via ${chat.sourceUrl}`);
console.log(`  ${ids.length} models: ${ids.join(', ')}`);

if (chat.status === 'live' && ids.length > 0) {
  pass('catalog_is_live', `${ids.length} models from ${chat.sourceUrl}`);
} else {
  fail(
    'catalog_is_live',
    `status=${chat.status} reason=${chat.degradedReason}`
  );
}

if (chat.sourceUrl.startsWith('https://api.orcarouter.ai/v1/models')) {
  pass('catalog_uses_api_origin', chat.sourceUrl);
} else {
  fail('catalog_uses_api_origin', chat.sourceUrl);
}

// The seed must never appear in a successful live result: a blended catalog is how a model nobody
// can call ends up in a dropdown.
const blended = chat.models
  .filter((model) => model.fromSeed)
  .map((model) => model.id);
if (chat.status === 'live' && blended.length === 0) {
  pass('no_seed_in_live_result', 'every entry came from the live response');
} else {
  fail(
    'no_seed_in_live_result',
    `seed entries in a ${chat.status} result: ${blended.join(', ')}`
  );
}

// --- 2. a real completion, through the shipped request path ----------------
/*
 * The model comes from the catalog above rather than from a literal, so this keeps working when the
 * catalog changes and fails loudly when it stops offering anything callable.
 *
 * WHY IT TRIES MORE THAN ONE. An OrcaRouter key can be scoped to a subset of the catalog, and a model
 * this key may not call answers 403 `model_access_denied`. That is a property of the key, not a
 * defect in the provider path, so the check walks the catalog until one model answers and reports
 * which it used. A run where nothing answers is a real failure.
 */
/** Per-model ceiling. The check tries several models, so this bounds each attempt, not the run. */
const COMPLETION_TIMEOUT_MS = 60_000;

const attempts = [];
let reply = '';
let calledModel = '';
for (const candidate of ids) {
  try {
    const response = await sendProviderRequest({
      model: candidate,
      path: '/chat/completions',
      body: {
        messages: [
          { role: 'user', content: 'Reply with exactly one word: orca' },
        ],
        max_tokens: 16,
      },
      env,
      // BOUNDED, because this walks every candidate model. sendProviderRequest already forwards a
      // signal to fetch; nothing was passing one, so a single model that accepts the connection and
      // never answers hangs the whole live check with no output and no timeout above it.
      signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
    });
    const choice = response.json?.choices?.[0];
    const content = String(choice?.message?.content ?? '').trim();
    if (response.ok && content.length > 0) {
      calledModel = candidate;
      reply = content;
      attempts.push(`${candidate}: HTTP ${response.status}`);
      break;
    }
    attempts.push(`${candidate}: HTTP ${response.status}`);
  } catch (error) {
    attempts.push(`${candidate}: ${error?.status ?? error?.name ?? 'error'}`);
  }
}

if (calledModel) {
  pass(
    'inference_round_trip',
    `${calledModel} -> "${reply.slice(0, 40)}" (after ${attempts.length} attempt(s))`
  );
} else {
  fail(
    'inference_round_trip',
    `no catalog model answered: ${attempts.join(', ')}`
  );
}

// --- 3. the multimodal filter, when the catalog can demonstrate it ---------
const multimodal = await discoverModels(
  { capability: 'chat', requiresInputModality: 'image' },
  env
);
const imageIds = multimodal.models.map((model) => model.id);
console.log(
  `\nmultimodal catalog: ${multimodal.status}, ${imageIds.length} models`
);
if (imageIds.length) console.log(`  ${imageIds.join(', ')}`);

const chatSet = new Set(ids);
const allDeclareImage = multimodal.models.every((model) =>
  model.inputModalities.includes('image')
);
const strictSubset = imageIds.every((id) => chatSet.has(id));

if (allDeclareImage && strictSubset) {
  pass(
    'multimodal_is_a_declared_subset',
    `${imageIds.length} of ${ids.length} chat models declare image input`
  );
} else {
  fail(
    'multimodal_is_a_declared_subset',
    `allDeclareImage=${allDeclareImage} strictSubset=${strictSubset}`
  );
}

console.log(
  `\n${failures.length === 0 ? 'live check passed' : `live check FAILED: ${failures.join(', ')}`}`
);
if (failures.length) process.exitCode = 1;
