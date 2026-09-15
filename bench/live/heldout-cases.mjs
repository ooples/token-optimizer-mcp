/** Confirmation-only generated cases. Never used to tune the frozen product. */
import { createHash } from 'node:crypto';
import {
  workflow as developmentWorkflow,
  validateWorkflow,
} from './codex-workflows.mjs';

function parameters(task, seed) {
  const hash = createHash('sha256')
    .update(`heldout-v1:${task}:${seed}`)
    .digest();
  return {
    number: hash.readUInt32LE(0),
    tag: hash.subarray(4, 8).toString('hex'),
    bytes: hash,
  };
}
export function heldoutFixture(task, seed) {
  const { number, tag, bytes } = parameters(task, seed);
  const length = 220 + (number % 101);
  const marker = 10 + (bytes.readUInt16LE(8) % (length - 20));
  if (task === 'logs') {
    const expected = {
      request: `req-${tag}`,
      code: ['E_TIMEOUT', 'E_POOL_EXHAUSTED', 'E_CHECKSUM'][bytes[10] % 3],
      worker: `worker-${1 + (bytes[11] % 16)}`,
    };
    return {
      name: 'service.log',
      expected,
      content: Array.from({ length }, (_, i) =>
        i === marker
          ? `2026-09-15T12:00:00Z ERROR env=production request=${expected.request} code=${expected.code} worker=${expected.worker}`
          : i % 61 === 0
            ? `2026-09-15T12:00:00Z ERROR env=staging request=canary-${i} code=E_CANARY worker=worker-0`
            : `2026-09-15T12:00:00Z INFO env=production heartbeat healthy worker=worker-${i % 3}`
      ).join('\n'),
      question:
        'Find the ERROR event in production (ignore staging canaries). Write answer.json containing its request, code, and worker as strings.',
    };
  }
  if (task === 'json') {
    const id = `record-${tag}-${marker}`;
    const reason = ['checksum_mismatch', 'lease_expired', 'quota_exceeded'][
      bytes[10] % 3
    ];
    const content = Array.from({ length }, (_, i) => ({
      id: `record-${tag}-${i}`,
      status: 'ok',
      reason: 'none',
      region: ['east', 'west'][i % 2],
      attempts: 1,
    }));
    for (const offset of [0, 17, 37]) {
      const index = (marker + offset) % length;
      content[index].status = 'failed';
      content[index].reason = offset ? 'transient_failure' : reason;
      content[index].attempts = offset ? 2 : 4 + (bytes[11] % 8);
    }
    return {
      name: 'records.json',
      content: JSON.stringify(content, null, 2),
      expected: { id, status: 'failed', reason },
      question:
        'Among failed records, find the one with the greatest attempts. Write answer.json containing its id, status, and reason as strings.',
    };
  }
  if (task !== 'code') throw Error(`Unknown held-out fixture ${task}`);
  const constant = `RETRY_LIMIT_${tag.toUpperCase()}`,
    file = `src/queue-${tag}.ts`,
    value = 2 + (bytes[12] % 29);
  return {
    name: 'search.txt',
    expected: { file, line: marker + 1, constant, value },
    content: Array.from(
      { length: length + 50 },
      (_, i) =>
        `${file}:${i + 1}:${i === marker ? `export const ${constant} = ${value};` : `export const FEATURE_${i} = ${i % 2 === 0};`}`
    ).join('\n'),
    question: `Find ${constant}. Write answer.json containing file, line (number), constant, and value (number).`,
  };
}

export function heldoutWorkflow(task, seed) {
  const f = developmentWorkflow(task, seed);
  const { number, tag, bytes } = parameters(task, seed);
  if (task === 'bugfix') {
    const base = 50 + bytes[8],
      cap = 500 + bytes[9] * 7,
      max = 2 + (bytes[10] % 4);
    f.files['test/retry.test.mjs'] =
      `import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {next} from '../src/client.mjs';\nconst p={maxAttempts:${max},baseMs:${base},capMs:${cap}};\nfor(const status of [201,429,430,500,599,600]) for(const attempt of [1,2,3,4,5]) test('case '+status+'/'+attempt,()=>{assert.equal(next({status},attempt,p),(status===429||status>=500&&status<=599)&&attempt<${max}?Math.min(${cap},${base}*2**(attempt-1)):null);});\n`;
    f.files['src/retry.mjs'] = [
      'export function retryDelay({status,attempt,maxAttempts,retryAfter,baseMs,capMs}) { if(attempt>maxAttempts||status<429)return null; return Number(retryAfter)*1000||baseMs*2**attempt; }\n',
      'export function retryDelay({status,attempt,maxAttempts,retryAfter,baseMs,capMs}) { if(attempt>=maxAttempts||status<500)return null; const delay=retryAfter?Number(retryAfter):baseMs*2**(attempt-1); return Math.max(capMs,delay); }\n',
      'export function retryDelay({status,attempt,maxAttempts,retryAfter,baseMs,capMs}) { if(status!==429&&status<500)return null; return Math.min(capMs,baseMs*attempt); }\n',
    ][number % 3];
    return f;
  }
  if (task === 'refactor') {
    const cents = 101 + bytes[8],
      quantity = 2 + (bytes[9] % 4),
      bps = 125 + bytes[10] * 13;
    const expected =
      Math.round((cents * quantity * (10000 - bps)) / 10000) / 100;
    f.files['test/public.test.mjs'] =
      `import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {invoice,quote} from '../src/index.mjs';\ntest('public round-once contract ${tag}',()=>{const items=[{price:${cents / 100},quantity:${quantity}}];assert.deepEqual(invoice(items,${bps / 100}),{total:${expected},count:1});assert.equal(quote(items,${bps / 100}),${expected});});\n`;
    f.files['src/money.mjs'] =
      number % 2
        ? 'export function priceTotal(items, discountPercent=0) { let total=0; for(const item of items) total+=item.price*item.quantity; return total*(100-discountPercent)/100; }\n'
        : f.files['src/money.mjs'];
    return f;
  }
  const count = 220 + (number % 101);
  const marker = bytes.readUInt16LE(8) % count;
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `route-${tag}-${i}`,
    enabled: true,
    limit: 80 + bytes[11],
    region: i % 2 ? 'west' : 'east',
  }));
  for (let i = 1; i <= 1 + (bytes[12] % 4); i++)
    rows[(marker + 31 * i) % count].enabled = false;
  const beforeIds = rows.filter((r) => !r.enabled).map((r) => r.id);
  const initial = JSON.stringify(rows, null, 2);
  const baseLimit = 200 + bytes[13],
    effectiveLimit = bytes[14] % 31;
  rows[marker].enabled = false;
  rows[marker].limit = baseLimit;
  const route = rows[marker].id;
  return {
    ...f,
    marker,
    route,
    beforeIds,
    beforeDisabled: beforeIds.length,
    baseLimit,
    effectiveLimit,
    final: JSON.stringify(rows, null, 2),
    files: {
      'routes.json': initial,
      'refresh.mjs': `import {readFile,writeFile,rename} from 'node:fs/promises';\nconst rows=JSON.parse(await readFile('routes.json','utf8'));\nrows[${marker}].enabled=false;rows[${marker}].limit=${baseLimit};\nawait writeFile('routes.next',JSON.stringify(rows,null,2));await rename('routes.next','routes.json');\nawait writeFile('override.json',JSON.stringify({route:${JSON.stringify(route)},limit:${effectiveLimit}}));\nconsole.log('Refresh complete; reread current configuration.');\n`,
    },
  };
}
export function validateHeldoutWorkflow(task, work, seed) {
  return validateWorkflow(task, work, seed, heldoutWorkflow(task, seed));
}
