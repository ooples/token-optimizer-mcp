import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/**
 * THE RATCHET WITHHOLDS NOTHING THE STORE-EMPTY RECORD PASSES.
 *
 * `warmOnly` in the ratchet lists criteria that pass only while their store is
 * warm, which the gate refuses to enforce. It used to be final: once a key was
 * listed, the gate filtered it out before ever looking at the store-empty
 * record again, so a re-record that showed it passing from an empty store
 * could not promote it. Eight criteria sat there on #436-#438 and #441-#443
 * while store-pair.check.mjs reported every one of them holding from either
 * store.
 *
 * This judges the published store-empty pair with the real gate and requires
 * that no key the ratchet withholds passes on it. A key that does pass is
 * enforceable, and a gate that keeps withholding it is the defect again.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const GATE = join(repo, 'bench', 'compression', 'must-win.check.mjs');
const RECORDS = join(repo, 'bench', 'compression', 'headroom', 'results');
const RUN_MS = 180000;

describe('the warm-only list', () => {
  it(
    'holds no criterion that passes from an empty store',
    () => {
      const run = spawnSync(
        process.execPath,
        [
          GATE,
          '--results',
          join(RECORDS, 'head-to-head.store-empty.json'),
          '--replicate',
          join(RECORDS, 'head-to-head.store-empty.replicate.json'),
          '--json',
        ],
        { cwd: repo, encoding: 'utf8' }
      );
      const onEmpty = JSON.parse(run.stdout);
      // Not vacuous: the empty record really is judged, criterion by criterion.
      expect(Object.keys(onEmpty).length).toBeGreaterThan(5);

      const { warmOnly = [] } = JSON.parse(
        readFileSync(join(RECORDS, 'must-win.ratchet.json'), 'utf8')
      );
      const enforceable = warmOnly.filter((key) => {
        const cut = key.lastIndexOf('/');
        return onEmpty[key.slice(0, cut)]?.[key.slice(cut + 1)]?.pass === true;
      });
      expect(enforceable).toEqual([]);
    },
    RUN_MS
  );
});
