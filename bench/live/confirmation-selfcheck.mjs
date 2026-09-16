/** Preflight generators/oracles without provider calls or product tuning. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  heldoutFixture,
  heldoutWorkflow,
  validateHeldoutWorkflow,
} from './heldout-cases.mjs';
const plan = JSON.parse(await readFile(process.argv[2], 'utf8'));
const root = await mkdtemp(join(tmpdir(), 'confirmation-preflight-'));
let fixtures = 0,
  oracles = 0;
try {
  for (const item of plan.schedule) {
    if (['logs', 'json', 'code'].includes(item.task)) {
      const f = heldoutFixture(item.task, item.seed);
      if (item.task === 'json') {
        const target = JSON.parse(f.content)
          .filter((r) => r.status === 'failed')
          .sort((a, b) => b.attempts - a.attempts)[0];
        assert.deepEqual(f.expected, {
          id: target.id,
          status: target.status,
          reason: target.reason,
        });
      } else if (item.task === 'logs') {
        const rows = f.content
          .split('\n')
          .filter((l) => l.includes('ERROR env=production'));
        assert.equal(rows.length, 1);
        for (const [k, v] of Object.entries(f.expected))
          assert.ok(rows[0].includes(`${k}=${v}`));
      } else
        assert.ok(
          f.content
            .split('\n')
            .includes(
              `${f.expected.file}:${f.expected.line}:export const ${f.expected.constant} = ${f.expected.value};`
            )
        );
      fixtures++;
      continue;
    }
    const f = heldoutWorkflow(item.task, item.seed),
      work = join(root, item.id);
    for (const [name, content] of Object.entries(f.files)) {
      await mkdir(dirname(join(work, name)), { recursive: true });
      await writeFile(join(work, name), content);
    }
    if (item.task === 'refresh') {
      await writeFile(
        join(work, 'before.json'),
        JSON.stringify({
          disabledCount: f.beforeDisabled,
          disabledRoutes: f.beforeIds,
        })
      );
      execFileSync(process.execPath, ['refresh.mjs'], {
        cwd: work,
        windowsHide: true,
      });
      await writeFile(
        join(work, 'answer.json'),
        JSON.stringify({
          disabledRoute: f.route,
          baseLimit: f.baseLimit,
          effectiveLimit: f.effectiveLimit,
        })
      );
    } else if (item.task === 'bugfix') {
      await writeFile(
        join(work, 'src/retry.mjs'),
        `export function retryDelay({status,attempt,maxAttempts,retryAfter,baseMs,capMs}){if(attempt>=maxAttempts||!(status===429||status>=500&&status<=599))return null;const s=retryAfter===undefined?NaN:Number(retryAfter);return Math.min(capMs,Number.isFinite(s)&&s>=0?s*1000:baseMs*2**(attempt-1));}`
      );
    } else {
      await writeFile(
        join(work, 'src/money.mjs'),
        'export function totalCents(items,bps=0){return Math.round(items.reduce((s,i)=>s+i.unitCents*i.quantity,0)*(10000-bps)/10000)}'
      );
      await writeFile(
        join(work, 'src/invoice.mjs'),
        "import {totalCents} from './money.mjs'; export function invoice(items,p=0){return {total:totalCents(items.map(i=>({unitCents:i.price*100,quantity:i.quantity})),p*100)/100,count:items.length}};"
      );
      await writeFile(
        join(work, 'src/quote.mjs'),
        "import {invoice} from './invoice.mjs'; export function quote(items,p=0){return invoice(items,p).total}"
      );
      await writeFile(
        join(work, 'src/index.mjs'),
        "export {totalCents} from './money.mjs';export {invoice} from './invoice.mjs';export {quote} from './quote.mjs';"
      );
    }
    const good = await validateHeldoutWorkflow(item.task, work, item.seed);
    assert.equal(
      good.passed,
      true,
      JSON.stringify({ id: item.id, failures: good.failures })
    );
    if (item.task === 'refresh')
      await writeFile(join(work, 'answer.json'), '{}');
    else
      await writeFile(
        join(work, item.task === 'bugfix' ? 'src/retry.mjs' : 'src/money.mjs'),
        'export const broken=true;'
      );
    assert.equal(
      (await validateHeldoutWorkflow(item.task, work, item.seed)).passed,
      false,
      `Oracle accepted broken ${item.id}`
    );
    oracles++;
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    fixtureKeysChecked: fixtures,
    goodAndBadOracleCases: oracles,
  })
);
