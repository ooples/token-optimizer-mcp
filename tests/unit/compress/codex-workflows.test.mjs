import { test, expect } from '@jest/globals';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  workflow,
  validateWorkflow,
} from '../../../bench/live/codex-workflows.mjs';
const exec = promisify(execFile);
async function setup(task, seed = 1) {
  const work = await mkdtemp(join(tmpdir(), 'workflow-validator-'));
  const f = workflow(task, seed);
  for (const [name, content] of Object.entries(f.files)) {
    await mkdir(dirname(join(work, name)), { recursive: true });
    await writeFile(join(work, name), content);
  }
  return { work, f };
}
test('missing and malformed refresh artifacts produce deterministic failures', async () => {
  const { work } = await setup('refresh');
  for (const text of [undefined, '{invalid', 'null']) {
    if (text !== undefined) await writeFile(join(work, 'before.json'), text);
    expect(await validateWorkflow('refresh', work)).toEqual({
      passed: false,
      failures: ['Missing or invalid refresh artifact'],
    });
  }
});
test.each([1, 4])(
  'bugfix oracle rejects incomplete fixes for seed %s',
  async (seed) => {
    const { work } = await setup('bugfix', seed);
    expect((await validateWorkflow('bugfix', work, seed)).passed).toBe(false);
    await writeFile(
      join(work, 'src/retry.mjs'),
      'export function retryDelay({status,baseMs}) { return status===400?null:baseMs; }'
    );
    expect((await validateWorkflow('bugfix', work, seed)).passed).toBe(false);
    await writeFile(
      join(work, 'src/retry.mjs'),
      `export function retryDelay({status,attempt,maxAttempts,retryAfter,baseMs,capMs}) {
    if(attempt>=maxAttempts || !(status===429 || status>=500&&status<=599)) return null;
    const s=retryAfter===undefined?NaN:Number(retryAfter);
    return Math.min(capMs,Number.isFinite(s)&&s>=0?s*1000:baseMs*2**(attempt-1));
  }`
    );
    expect((await validateWorkflow('bugfix', work, seed)).passed).toBe(true);
    await writeFile(join(work, 'test/retry.test.mjs'), '');
    expect((await validateWorkflow('bugfix', work, seed)).passed).toBe(false);
  }
);
test.each([1, 4])(
  'refactor oracle catches missed callers for seed %s',
  async (seed) => {
    const { work } = await setup('refactor', seed);
    expect((await validateWorkflow('refactor', work, seed)).passed).toBe(false);
    await writeFile(
      join(work, 'src/money.mjs'),
      'export function totalCents(items,bps=0){return Math.round(items.reduce((s,x)=>s+x.unitCents*x.quantity,0)*(10000-bps)/10000);}'
    );
    expect((await validateWorkflow('refactor', work, seed)).passed).toBe(false);
    await writeFile(
      join(work, 'src/invoice.mjs'),
      "import {totalCents} from './money.mjs'; export function invoice(items,p=0){return {total:totalCents(items.map(x=>({unitCents:Math.round(x.price*100),quantity:x.quantity})),p*100)/100,count:items.length};}"
    );
    await writeFile(
      join(work, 'src/quote.mjs'),
      "import {invoice} from './invoice.mjs';export function quote(items,p=0){return invoice(items,p).total;}"
    );
    await writeFile(
      join(work, 'src/index.mjs'),
      "export {totalCents} from './money.mjs';export {invoice} from './invoice.mjs';export {quote} from './quote.mjs';"
    );
    expect((await validateWorkflow('refactor', work, seed)).passed).toBe(true);
  }
);
test.each([1, 2, 3, 7])(
  'refresh oracle rejects stale answers for seed %s',
  async (seed) => {
    const { work, f } = await setup('refresh', seed);
    await writeFile(
      join(work, 'before.json'),
      JSON.stringify({
        disabledCount: f.beforeDisabled,
        disabledRoutes: seed >= 7 ? [`route-${f.previous}`] : [],
      })
    );
    await exec(process.execPath, ['refresh.mjs'], { cwd: work });
    await writeFile(
      join(work, 'answer.json'),
      JSON.stringify({
        disabledRoute: `route-${f.marker}`,
        baseLimit: 100,
        effectiveLimit: 100,
      })
    );
    expect((await validateWorkflow('refresh', work, seed)).passed).toBe(false);
    await writeFile(
      join(work, 'answer.json'),
      JSON.stringify({
        disabledRoute: `route-${f.marker}`,
        baseLimit: 101,
        effectiveLimit: 7,
      })
    );
    expect((await validateWorkflow('refresh', work, seed)).passed).toBe(true);
    if (seed >= 7) {
      await writeFile(
        join(work, 'before.json'),
        '{"disabledCount":0,"disabledRoutes":[]}'
      );
      expect((await validateWorkflow('refresh', work, seed)).passed).toBe(
        false
      );
    }
  }
);
