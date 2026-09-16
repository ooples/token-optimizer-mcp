/** Natural workflows. Evaluators run after Codex exits, outside its task tree. */
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
export const workflowTasks = ['bugfix', 'refactor', 'refresh'];

export function workflow(task, seed = 1) {
  const marker = 13 + ((seed * 37) % 181);
  if (task === 'bugfix')
    return {
      files: {
        'README.md':
          'Retry policy: maxAttempts includes the first attempt. Retry only HTTP 429 and 500-599. Retry-After is seconds (including zero); otherwise exponential delay baseMs * 2 ** (attempt - 1), capped at capMs. Never exceed capMs. Invalid or negative Retry-After uses the fallback.\nRun node --test. Edit implementation only.\n',
        'src/retry.mjs':
          'export function retryDelay({status, attempt, maxAttempts, retryAfter, baseMs, capMs}) {\n  if (attempt > maxAttempts || status < 429) return null;\n  return Number(retryAfter) * 1000 || baseMs * 2 ** attempt;\n}\n',
        'src/client.mjs':
          "import { retryDelay } from './retry.mjs';\nexport function next(response, attempt, policy) { return retryDelay({...policy, status: response.status, retryAfter: response.retryAfter, attempt}); }\n",
        'test/retry.test.mjs':
          seed < 4
            ? "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {next} from '../src/client.mjs';\nconst p={maxAttempts:3,baseMs:125,capMs:2000};\nfor(let i=0;i<80;i++) test('retry case '+i,()=>{assert.equal(next({status:503},1,p),125); assert.equal(next({status:400},1,p),null);});\n"
            : "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {next} from '../src/client.mjs';\nconst p={maxAttempts:4,baseMs:173,capMs:777};\nfor(const status of [200,429,430,500,599,600]) for(const attempt of [1,2,3,4]) test(`status ${status} attempt ${attempt}`,()=>{const expected=(status===429 || status>=500&&status<600)&&attempt<4?Math.min(777,173*2**(attempt-1)):null;assert.equal(next({status},attempt,p),expected);});\n",
      },
      editable: ['src/retry.mjs'],
      prompt:
        'Fix the retry-policy bug in this repository. Read the requirements, run the existing tests before editing, implement the fix, then run the tests again. Preserve the public API and do not modify tests or requirements. Choose your own searches and reads.',
    };
  if (task === 'refactor')
    return {
      files: {
        'README.md':
          'Refactor money handling to integer cents. Replace exported priceTotal(items, discountPercent) with totalCents(items, discountBasisPoints). Each input item uses unitCents and quantity. Round once after summing and applying the basis-point discount. Preserve invoice and quote public APIs, which accept dollars and percent and return dollars. Remove all references to priceTotal from src. Run node --test.\n',
        'src/money.mjs':
          'export function priceTotal(items, discountPercent = 0) { return items.reduce((s,x)=>s+x.price*x.quantity,0)*(1-discountPercent/100); }\n',
        'src/invoice.mjs':
          "import {priceTotal} from './money.mjs';\nexport function invoice(items, discountPercent=0){return {total:priceTotal(items,discountPercent),count:items.length};}\n",
        'src/quote.mjs':
          "import {priceTotal as total} from './money.mjs';\nexport function quote(items,discountPercent=0){return total(items,discountPercent);}\n",
        'src/index.mjs':
          "export {priceTotal} from './money.mjs';\nexport {invoice} from './invoice.mjs';\nexport {quote} from './quote.mjs';\n",
        'test/public.test.mjs':
          seed < 4
            ? "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {invoice,quote} from '../src/index.mjs';\ntest('public APIs',()=>{assert.deepEqual(invoice([{price:10,quantity:2}],10),{total:18,count:1});assert.equal(quote([{price:10,quantity:2}],10),18);});\n"
            : "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {invoice,quote} from '../src/index.mjs';\ntest('fractional discount rounds once',()=>{const items=[{price:1.99,quantity:3}];assert.deepEqual(invoice(items,12.5),{total:5.22,count:1});assert.equal(quote(items,12.5),5.22);});\n",
      },
      editable: [
        'src/money.mjs',
        'src/invoice.mjs',
        'src/quote.mjs',
        'src/index.mjs',
      ],
      prompt:
        'Perform the money API migration described in README.md across this repository. Preserve the invoice and quote APIs. Run the tests before and after your edits. Do not modify tests or requirements. Choose your own searches and reads.',
    };
  if (task !== 'refresh') throw Error('Unknown workflow');
  const before = Array.from({ length: 240 }, (_, i) => ({
    id: `route-${i}`,
    enabled: true,
    limit: 100,
    region: 'east',
  }));
  const previous = (marker + 31) % before.length;
  if (seed >= 7) before[previous].enabled = false;
  const after = structuredClone(before);
  after[marker].enabled = false;
  after[marker].limit = 101;
  const initial = JSON.stringify(before, null, 2);
  const final = JSON.stringify(after, null, 2);
  return {
    files: {
      'routes.json': initial,
      'refresh.mjs': `import {writeFile,rename} from 'node:fs/promises';\nconst rows=JSON.parse(await (await import('node:fs/promises')).readFile('routes.json','utf8'));\nrows[${marker}].enabled=false;rows[${marker}].limit=101;\nawait writeFile('routes.next',JSON.stringify(rows,null,2));await rename('routes.next','routes.json');\nawait writeFile('override.json',JSON.stringify({route:'route-${marker}',limit:7}));\nconsole.log('Refresh complete; reread current configuration.');\n`,
    },
    editable: ['routes.json'],
    final,
    marker,
    beforeDisabled: seed >= 7 ? 1 : 0,
    previous,
    prompt:
      seed >= 7
        ? `Inspect routes.json and write before.json with disabledCount and disabledRoutes (an array of route IDs). Then run node refresh.mjs exactly once. Inspect the current configuration and new override, and write answer.json with the newly disabled route as disabledRoute (string), baseLimit (number), and effectiveLimit (number, from override.json). Existing disabled routes must remain disabled. Do not edit the configuration or refresh script yourself. Choose your own searches and reads.`
        : `Inspect routes.json and write before.json with the number of disabled routes as disabledCount. Then run node refresh.mjs exactly once to simulate an external file replacement and a newly created override. Inspect the current files and write answer.json with disabledRoute (string), baseLimit (number), and effectiveLimit (number, from override.json). Do not edit the configuration or refresh script yourself. Choose your own searches and reads.`,
  };
}

export async function validateWorkflow(task, work, seed = 1, suppliedFixture) {
  const f = suppliedFixture ?? workflow(task, seed);
  const failures = [];
  for (const [name, content] of Object.entries(f.files)) {
    if (
      !f.editable.includes(name) &&
      (await readFile(join(work, name), 'utf8')) !== content
    )
      failures.push(`Protected file changed: ${name}`);
  }
  if (task === 'refresh') {
    const parse = async (name) =>
      JSON.parse(
        (await readFile(join(work, name), 'utf8')).replace(/^\uFEFF/, '')
      );
    const before = await parse('before.json');
    const after = await parse('answer.json');
    if (
      before.disabledCount !== f.beforeDisabled ||
      after.disabledRoute !== (f.route ?? `route-${f.marker}`) ||
      after.baseLimit !== (f.baseLimit ?? 101) ||
      after.effectiveLimit !== (f.effectiveLimit ?? 7)
    )
      failures.push('Stale or incorrect configuration answer');
    if (
      seed >= 7 &&
      JSON.stringify(
        Array.isArray(before.disabledRoutes)
          ? [...before.disabledRoutes].sort()
          : null
      ) !== JSON.stringify([...(f.beforeIds ?? [`route-${f.previous}`])].sort())
    )
      failures.push('Missed pre-existing disabled route');
    if ((await readFile(join(work, 'routes.json'), 'utf8')) !== f.final)
      failures.push('Unexpected final routes');
    const override = await parse('override.json');
    if (
      override.route !== (f.route ?? `route-${f.marker}`) ||
      override.limit !== (f.effectiveLimit ?? 7)
    )
      failures.push('Unexpected override');
  } else {
    const moduleUrl = pathToFileURL(
      join(work, task === 'bugfix' ? 'src/client.mjs' : 'src/index.mjs')
    ).href;
    // This oracle is deliberately separate from public fixture tests and executes
    // in a fresh process, so imported agent code cannot affect the host validator.
    const checks =
      task === 'bugfix'
        ? `
      const {next}=await import(${JSON.stringify(moduleUrl)});
      for(const status of [200,408,425,429,430,499,500,503,599,600])
      for(const attempt of [1,2,3,4])
      for(const retryAfter of [undefined,'0','0.25','9','-1','bad']) {
        const policy={maxAttempts:3,baseMs:137,capMs:1700};
        const retryable=status===429 || (status>=500 && status<=599);
        const seconds=retryAfter===undefined?NaN:Number(retryAfter);
        const delay=Number.isFinite(seconds)&&seconds>=0?seconds*1000:137*2**(attempt-1);
        const expected=attempt>=3||!retryable?null:Math.min(1700,delay);
        assert.equal(next({status,retryAfter},attempt,policy),expected,JSON.stringify({status,attempt,retryAfter}));
      }`
        : `
      const api=await import(${JSON.stringify(moduleUrl)});
      assert.equal('priceTotal' in api,false);
      for(const unitCents of [1,17,199,1001]) for(const quantity of [0,1,3]) for(const bps of [0,125,3333,10000]) {
        const expected=Math.round((unitCents*quantity+37*2)*(10000-bps)/10000);
        assert.equal(api.totalCents([{unitCents,quantity},{unitCents:37,quantity:2}],bps),expected);
        const items=[{price:unitCents/100,quantity},{price:.37,quantity:2}];
        assert.deepEqual(api.invoice(items,bps/100),{total:expected/100,count:2});
        assert.equal(api.quote(items,bps/100),expected/100);
      }
      assert.equal(api.totalCents([]),0);`;
    try {
      await exec(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import assert from 'node:assert/strict';${checks}`,
        ],
        { timeout: 15000, maxBuffer: 16000 }
      );
      await exec(process.execPath, ['--test'], {
        cwd: work,
        timeout: 15000,
        maxBuffer: 128000,
      });
    } catch (error) {
      failures.push(String(error.stderr || error.message).slice(0, 3000));
    }
    if (task === 'refactor')
      for (const name of f.editable) {
        if ((await readFile(join(work, name), 'utf8')).includes('priceTotal'))
          failures.push(`Old API remains: ${name}`);
      }
  }
  return { passed: failures.length === 0, failures };
}
