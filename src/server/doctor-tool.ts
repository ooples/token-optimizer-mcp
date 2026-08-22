/**
 * The install doctor, exposed as a tool.
 *
 * Runs the enforcement path for real rather than inspecting configuration, so a
 * PASS means a refusal actually came back out of the hook binary -- not that the
 * files are where they should be. That distinction is not academic: this project
 * shipped a version where every configuration check would have passed and the
 * plugin saved nothing.
 *
 * The MCP server probe is skipped when running inside the server itself, because
 * spawning a second copy of the process that is answering the call is a way to
 * deadlock rather than a way to learn anything.
 */

import path from 'path';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

function coreUrl(name: string): string {
  return pathToFileURL(path.join(here, '..', '..', 'hooks-core', name)).href;
}

let cached: { doctor: any; wiki: any; manifest: any } | null = null;

async function modules() {
  if (cached) return cached;
  try {
    const [doctor, wiki, manifest] = await Promise.all([
      import(coreUrl('doctor.mjs')),
      import(coreUrl('wiki.mjs')),
      import(coreUrl('manifest.mjs')),
    ]);
    cached = { doctor, wiki, manifest };
    return cached;
  } catch {
    return null;
  }
}

const say = (body: string, isError = false) => ({
  content: [{ type: 'text', text: body }],
  isError,
});

export async function installDoctor(input: {
  uninstallPlan?: boolean;
  /**
   * Set by the server when its cache fell back to memory. Passed in rather than
   * detected here because it is a property of THIS process, not of the files on
   * disk -- a second CacheEngine built by the doctor might well open fine.
   */
  cacheDegradedReason?: string | null;
}): Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}> {
  const mods = await modules();
  if (!mods)
    return say(
      'The doctor is unavailable: the modules could not be loaded.',
      true
    );

  const root = path.join(here, '..', '..');
  const cwd = process.cwd();

  if (input?.uninstallPlan) {
    const plan = mods.manifest.removalPlan();
    if (!plan) {
      return say(
        'No installation record found, so there is nothing we can prove is ours to remove. ' +
          'We will not guess: remove the token-optimizer entries from settings.json by hand if you installed manually.'
      );
    }
    return say(
      [
        `Would remove ${plan.remove.length} file(s) we wrote and that are unchanged.`,
        ...plan.remove.map((p: string) => `  - ${p}`),
        ...(plan.keep.length
          ? [
              '',
              'Leaving alone (edited since we wrote them):',
              ...plan.keep.map((k: any) => `  ! ${k.path} -- ${k.why}`),
            ]
          : []),
        '',
        plan.untouched,
        '',
        'Nothing has been changed. Run `node scripts/uninstall.mjs --apply` to carry it out.',
      ].join('\n')
    );
  }

  const result = await mods.doctor.diagnose({
    root,
    workspace: path.join(os.tmpdir(), 'token-optimizer-doctor'),
    graphDir: mods.wiki.wikiDir(cwd),
    settingsPath:
      process.env.TOKEN_OPTIMIZER_SETTINGS ||
      path.join(os.homedir(), '.claude', 'settings.json'),
    // We ARE the server. Spawning another copy to ask it questions deadlocks.
    skipServer: true,
    cacheDegradedReason: input?.cacheDegradedReason ?? null,
  });

  return say(mods.doctor.renderDiagnosis(result));
}

export const DOCTOR_TOOL = {
  name: 'install_doctor',
  description:
    'Check that this installation actually works. Runs the real hook binaries with synthetic payloads and asserts a large read ' +
    'is refused and a small one is not, that session-start emits the policy, and that the graph directory is writable and private ' +
    '-- rather than checking that config files exist, which can pass while the plugin saves nothing. Every failure names its fix. ' +
    'Pass uninstallPlan=true to see exactly what a removal would delete and what it would refuse to touch.',
  inputSchema: {
    type: 'object',
    properties: {
      uninstallPlan: {
        type: 'boolean',
        description: 'Show what uninstall would remove, changing nothing',
      },
    },
  },
} as const;
