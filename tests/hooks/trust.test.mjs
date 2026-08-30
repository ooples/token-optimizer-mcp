/**
 * Distribution trust: the manifest, the doctor, and the escape hatch.
 *
 * The properties under test are the ones that matter for software that refuses
 * your tool calls: removal is exact rather than best-effort and never destroys
 * a file the user has edited, the doctor proves enforcement by RUNNING it rather
 * than by inspecting configuration, and every refusal carries its own off
 * switch.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeManifest, readManifest, verifyManifest, removalPlan, uninstall,
  ourEntries, residue, fileHash,
} from '../../hooks-core/manifest.mjs';
import {
  checklist, probeEnforcement, probeSessionStart, probeGraph, diagnose, renderDiagnosis,
} from '../../hooks-core/doctor.mjs';
import { withEscape } from '../../hooks-core/policy.mjs';

const ROOT = join(process.cwd());

let workspace;
let target;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'trust-'));
  target = join(workspace, 'install.json');
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function installedFile(name, body = 'original contents') {
  const path = join(workspace, name);
  writeFileSync(path, body);
  return path;
}

describe('the manifest records exactly what we put on the machine', () => {
  test('files are recorded with the hash they had when written', () => {
    const path = installedFile('hook.mjs');
    writeManifest({ files: [path], version: '5.2.0' }, target);

    const manifest = readManifest(target);
    expect(manifest.files[0].sha256).toBe(fileHash(path));
    expect(manifest.packageVersion).toBe('5.2.0');
  });

  test('a file that could not be read is not recorded as installed', () => {
    writeManifest({ files: [join(workspace, 'never-existed.mjs')] }, target);
    expect(readManifest(target).files).toHaveLength(0);
  });

  test('verification separates intact, modified and missing', () => {
    const intact = installedFile('a.mjs');
    const edited = installedFile('b.mjs');
    const removed = installedFile('c.mjs');
    writeManifest({ files: [intact, edited, removed] }, target);

    writeFileSync(edited, 'the user changed this');
    rmSync(removed);

    const verified = verifyManifest(readManifest(target));
    expect(verified.intact).toBe(1);
    expect(verified.modified).toBe(1);
    expect(verified.missing).toBe(1);
  });
});

describe('removal is exact, and never destroys the user\'s work', () => {
  test('a file edited after we wrote it is kept, and the reason is named', () => {
    // Removing it destroys work that is now partly theirs; removing it silently
    // is worse than leaving it.
    const edited = installedFile('b.mjs');
    writeManifest({ files: [edited] }, target);
    writeFileSync(edited, 'the user changed this');

    const plan = removalPlan(readManifest(target));
    expect(plan.remove).toHaveLength(0);
    expect(plan.keep[0].why).toMatch(/edited after we wrote it/);
  });

  test('nothing outside the manifest is ever in the plan', () => {
    const ours = installedFile('ours.mjs');
    installedFile('theirs.mjs');
    writeManifest({ files: [ours] }, target);

    const plan = removalPlan(readManifest(target));
    expect(plan.remove).toEqual([ours]);
    expect(plan.untouched).toMatch(/not installed by us/);
  });

  test('uninstall is a dry run unless told otherwise', () => {
    // Deleting files on somebody else's machine is the last place to infer
    // consent from a function having been called.
    const path = installedFile('a.mjs');
    writeManifest({ files: [path] }, target);

    const out = uninstall({ manifest: readManifest(target) });
    expect(out.applied).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  test('applying removes the intact files and reports what it did', () => {
    const gone = installedFile('a.mjs');
    const kept = installedFile('b.mjs');
    writeManifest({ files: [gone, kept] }, target);
    writeFileSync(kept, 'edited');

    const out = uninstall({ apply: true, manifest: readManifest(target) });
    expect(out.removed).toEqual([gone]);
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });

  test('with no record, removal refuses to guess', () => {
    expect(uninstall({ manifest: null }).reason).toMatch(/no installation record/);
  });
});

describe('our config entries are found by what they run, not where they sit', () => {
  test('an entry that moved in the array is still ours', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { hooks: [{ command: 'node /somewhere/else/their-hook.mjs' }] },
          { hooks: [{ command: 'node ~/.claude-global/hooks/token-optimizer/router.mjs' }] },
        ],
      },
    };
    const found = ourEntries(settings);
    expect(found).toHaveLength(1);
    expect(found[0].value).toContain('token-optimizer');
  });

  test('an unparseable settings file is not evidence of cleanliness', () => {
    const path = join(workspace, 'settings.json');
    writeFileSync(path, '{ not json');
    expect(residue(path).clean).toBe(false);
  });

  test('a settings file with none of ours is clean', () => {
    const path = join(workspace, 'settings.json');
    writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'their-thing' }] }] } }));
    expect(residue(path).clean).toBe(true);
  });
});

describe('the doctor runs the thing rather than inspecting it', () => {
  test('a large read is actually refused by the real hook binary', async () => {
    // The check a checklist cannot make. This project shipped a version where
    // every configuration check passed and the hook saved nothing.
    const checks = await probeEnforcement({ root: ROOT, workspace });
    const refusal = checks.find((c) => c.name === 'enforcement refuses a large read');
    expect(refusal.pass).toBe(true);
  }, 30_000);

  test('a small read is left alone, because refusing everything is also broken', async () => {
    const checks = await probeEnforcement({ root: ROOT, workspace });
    expect(checks.find((c) => c.name === 'small reads are left alone').pass).toBe(true);
  }, 30_000);

  test('the session-start hook really emits the policy', async () => {
    const checks = await probeSessionStart({ root: ROOT, workspace });
    expect(checks[0].pass).toBe(true);
    expect(checks[0].detail).toMatch(/tokens of standing context/);
  }, 30_000);

  test('the graph directory is checked for writability and privacy', () => {
    const checks = probeGraph({ dir: join(workspace, 'wiki') });
    expect(checks.every((c) => c.pass)).toBe(true);
  });

  test('a missing hook binary fails with a remedy rather than an exception', async () => {
    const checks = await probeEnforcement({ root: join(workspace, 'nowhere'), workspace });
    expect(checks[0].pass).toBe(false);
    expect(checks[0].remedy).toBeTruthy();
  });

  test('every failing check names a fix, because a diagnosis without one is a complaint', () => {
    const checks = checklist({ root: join(workspace, 'nowhere'), settingsPath: join(workspace, 'nope.json') });
    for (const check of checks.filter((c) => !c.pass)) expect(check.remedy).toBeTruthy();
  });

  test('the rendered report states the off switch', async () => {
    const result = await diagnose({
      root: ROOT, workspace, graphDir: join(workspace, 'wiki'),
      settingsPath: join(workspace, 'nope.json'), skipServer: true,
    });
    const text = renderDiagnosis(result);
    expect(text).toMatch(/\d+\/\d+ checks passed/);
    expect(text).toMatch(/TOKEN_OPTIMIZER_MODE=off/);
  }, 30_000);
});

describe('the refusal carries its own off switch', () => {
  test('a denial tells you how to disable enforcement', () => {
    // Enforcement that hides its own disable is coercive. The person who needs
    // this is mid-refusal and not reading the README.
    expect(withEscape('auth.ts is 91 KB. Call smart_read instead.'))
      .toMatch(/TOKEN_OPTIMIZER_MODE=off disables enforcement/);
  });

  test('it is not appended twice when the reason already says it', () => {
    const reason = 'covered by a rule. Set TOKEN_OPTIMIZER_MODE=off to disable.';
    expect(withEscape(reason)).toBe(reason);
  });

  test('an empty reason still produces the escape hatch', () => {
    expect(withEscape('')).toMatch(/TOKEN_OPTIMIZER_MODE=off/);
  });
});
