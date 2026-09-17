/**
 * #395: an intentional TOKEN_OPTIMIZER_MODE=off is a healthy install that saves nothing.
 *
 * 7.0.1 reported it as one more PASS ("14/14 checks passed"), so a user asking "is this saving me
 * anything?" saw a clean sheet while the override sat unnoticed in ~/.claude/settings.json. The
 * install probes must still pass (they run in enforce mode on purpose, #390), but the report has to
 * lead with the disabled state, not count it as a pass, and say where the override lives.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { diagnose, renderDiagnosis, probeMode } from '../../hooks-core/doctor.mjs';

const ROOT = process.cwd();

let workspace;
let saved;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'doctor-mode-'));
  saved = process.env.TOKEN_OPTIMIZER_MODE;
});

afterEach(() => {
  if (saved === undefined) delete process.env.TOKEN_OPTIMIZER_MODE;
  else process.env.TOKEN_OPTIMIZER_MODE = saved;
  rmSync(workspace, { recursive: true, force: true });
});

function settingsWith(env) {
  const path = join(workspace, 'settings.json');
  writeFileSync(path, JSON.stringify({ env, hooks: {} }));
  return path;
}

describe('the effective mode check', () => {
  test('off from the settings file is a warning that names the file and the key', () => {
    process.env.TOKEN_OPTIMIZER_MODE = ' OFF ';
    const settingsPath = settingsWith({ TOKEN_OPTIMIZER_MODE: 'off' });
    const [check] = probeMode({ settingsPath });
    expect(check.warn).toBe(true);
    expect(check.pass).toBe(true);
    expect(check.detail).toContain(settingsPath);
    expect(check.remedy).toContain('TOKEN_OPTIMIZER_MODE');
    expect(check.remedy).toContain(settingsPath);
  });

  test('off from the process environment says so instead of blaming the settings file', () => {
    process.env.TOKEN_OPTIMIZER_MODE = 'off';
    const settingsPath = settingsWith({});
    const [check] = probeMode({ settingsPath });
    expect(check.warn).toBe(true);
    expect(check.detail).toContain('process environment');
    expect(check.detail).not.toContain(settingsPath);
  });

  test.each([undefined, 'assist', 'advise', 'enforce'])('mode %s is an ordinary pass', (value) => {
    if (value === undefined) delete process.env.TOKEN_OPTIMIZER_MODE;
    else process.env.TOKEN_OPTIMIZER_MODE = value;
    const [check] = probeMode({ settingsPath: settingsWith({}) });
    expect(check.pass).toBe(true);
    expect(check.warn).toBeFalsy();
  });
});

describe('the rendered report', () => {
  test('a disabled install is not a clean sheet', async () => {
    process.env.TOKEN_OPTIMIZER_MODE = 'off';
    const settingsPath = settingsWith({ TOKEN_OPTIMIZER_MODE: 'off' });
    const result = await diagnose({
      root: ROOT, workspace, graphDir: join(workspace, 'wiki'), settingsPath, skipServer: true,
    });
    expect(result.warnings).toBe(1);
    expect(result.passed).toBe(result.total - result.failed.length - 1);
    const text = renderDiagnosis(result);
    expect(text).toMatch(/^\d+\/\d+ checks passed, 1 warning\./);
    expect(text).toMatch(/\n {2}WARN {2}effective optimization mode\n/);
    expect(text).toContain('optimization is disabled by TOKEN_OPTIMIZER_MODE=off');
    expect(text).toContain(settingsPath);
    // The probes themselves still prove the install: an opt-out is not a broken hook.
    expect(result.checks.find((c) => c.name === 'session-start emits the policy')?.pass).toBe(true);
  }, 60_000);

  test('an enabled install reports no warning', async () => {
    delete process.env.TOKEN_OPTIMIZER_MODE;
    const result = await diagnose({
      root: ROOT, workspace, graphDir: join(workspace, 'wiki'),
      settingsPath: settingsWith({}), skipServer: true,
    });
    expect(result.warnings).toBe(0);
    expect(renderDiagnosis(result)).toMatch(/^\d+\/\d+ checks passed\./);
    expect(renderDiagnosis(result)).not.toContain('WARN');
  }, 60_000);
});
