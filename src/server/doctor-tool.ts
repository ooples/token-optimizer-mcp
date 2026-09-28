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
import { describePolicy } from '../telemetry/policy.js';
import { recordedBytes, recorderLastError } from '../telemetry/recorder.js';
import { pendingEvents } from '../telemetry/beacon.js';
import { pendingCounts } from '../telemetry/rollup.js';
import { beaconKey, beaconTable, beaconUrl } from '../telemetry/credentials.js';

const here = dirname(fileURLToPath(import.meta.url));

function coreUrl(name: string): string {
  return pathToFileURL(path.join(here, '..', '..', 'hooks-core', name)).href;
}

let cached: {
  doctor: any;
  wiki: any;
  manifest: any;
  capabilities: any;
} | null = null;

async function modules() {
  if (cached) return cached;
  try {
    const [doctor, wiki, manifest, capabilities] = await Promise.all([
      import(coreUrl('doctor.mjs')),
      import(coreUrl('wiki.mjs')),
      import(coreUrl('manifest.mjs')),
      import(coreUrl('capabilities.mjs')),
    ]);
    cached = { doctor, wiki, manifest, capabilities };
    return cached;
  } catch {
    return null;
  }
}

/**
 * What the telemetry switches are actually doing, in the doctor's own words.
 *
 * REPORTED, NEVER SENT: the doctor is run by people checking whether we are
 * uploading anything, and a diagnostic that uploaded while answering that
 * question would be the exact thing they were checking for. It reads the local
 * log and the resolved endpoint and prints them.
 *
 * It also states whether a key was packed, because a policy of "local and
 * upload: both explicitly enabled" with no key is a build that will never send
 * a byte, and an operator who opted in deserves to be told that rather than
 * left to wonder.
 */
export async function telemetrySection(
  env: NodeJS.ProcessEnv = process.env
): Promise<string[]> {
  const bytes = recordedBytes(env);
  const pending = (await pendingEvents(env)).length;
  const key = beaconKey(env);
  const lines = [
    '',
    'Telemetry',
    `  policy: ${describePolicy(env)}`,
    bytes === null
      ? '  local log: not written yet'
      : `  local log: ${bytes} bytes, ${pending} event(s) pending`,
    key
      ? `  upload target: ${beaconUrl(env)}/rest/v1/${beaconTable(env)}`
      : '  upload target: none -- this build was packed without a key, so nothing can be sent',
  ];
  // COUNTED BUT NOT YET WRITTEN. Usage is accumulated in memory and emitted one
  // rollup per window, so a proxy that has served fewer requests than a window
  // has nothing on disk and is not therefore failing to record. Shown only when
  // there is something to show, so the common case stays quiet.
  const counted = pendingCounts().requests;
  if (counted > 0) {
    lines.push(`  counted since the last rollup: ${counted} request(s)`);
  }
  const err = recorderLastError();
  if (err) lines.push(`  last recorder error: ${err}`);
  return lines;
}

const say = (body: string, isError = false) => ({
  content: [{ type: 'text', text: body }],
  isError,
});

export async function installDoctor(input: {
  uninstallPlan?: boolean;
  clientName?: string;
  /**
   * Diagnose this client instead of the one that opened the session.
   *
   * The handshake name is right for nearly every call, but it is not always
   * sent, and it is not always the install the user is asking about: a Codex
   * session debugging a Claude Code install had no way to say so, and a host
   * that sends no name at all falls back to the machine's registered plugin
   * -- which is how #408 read a Codex problem as a Claude version regression.
   */
  client?: string;
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

  // A NAME WE MANAGE, OR A LIST OF THE ONES WE DO. Read from the registry rather than a second
  // hand-kept enum: the last copy of that list went stale at three entries while MANAGED_CLIENTS
  // grew to ten, and a rejected-but-supported name here would be indistinguishable from a
  // genuinely unsupported client.
  const requested = String(input?.client || '')
    .trim()
    .toLowerCase();
  const managed: string[] = mods.capabilities.managedClientIds();
  if (requested && !managed.includes(requested)) {
    return say(
      `Unknown client "${requested}". Diagnosable clients: ${managed.join(', ')}.`,
      true
    );
  }

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
    clientName: input?.clientName,
    client: requested || null,
    // THE PROJECT, NOT THE PACKAGE. A client that reads its hooks from the repository it was
    // opened in is diagnosed against that repository; $root is where this server was installed.
    cwd,
    cacheDegradedReason: input?.cacheDegradedReason ?? null,
  });

  return say(
    [mods.doctor.renderDiagnosis(result), ...(await telemetrySection())].join('\n')
  );
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
      client: {
        type: 'string',
        description:
          'Diagnose this client instead of the one that opened the session (for example "codex"). ' +
          'Defaults to the client named in the MCP handshake.',
      },
    },
  },
} as const;
