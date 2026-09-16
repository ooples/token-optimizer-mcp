/** Contemporaneous Windows commit telemetry and a symmetric pre-attempt guard.
 * Never removes/retries completed attempts or reclassifies a loss as a win.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export const memoryPolicy = Object.freeze({
  platform: 'win32',
  minimumCommitReserveBytes: 2 * 1024 ** 3,
  minimumAvailablePhysicalBytes: 512 * 1024 ** 2,
  maximumSampleAgeMs: 5000,
});

export function memoryReady(sample, now = Date.now()) {
  return Boolean(
    sample &&
      Number.isFinite(sample.committedBytes) &&
      Number.isFinite(sample.commitLimitBytes) &&
      sample.committedBytes >= 0 &&
      sample.commitLimitBytes - sample.committedBytes >=
        memoryPolicy.minimumCommitReserveBytes &&
      Number.isFinite(sample.availablePhysicalBytes) &&
      sample.availablePhysicalBytes >=
        memoryPolicy.minimumAvailablePhysicalBytes &&
      now - Date.parse(sample.at) >= 0 &&
      now - Date.parse(sample.at) <= memoryPolicy.maximumSampleAgeMs
  );
}

export async function monitorHostMemory(directory) {
  if (process.platform !== 'win32')
    return { assertReady: async () => {}, stop: async () => {} };
  const log = createWriteStream(join(directory, 'host-memory.jsonl'), {
    flags: 'wx',
  });
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      await readFile(new URL('./host-memory.ps1', import.meta.url), 'utf8'),
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let sample,
    fault,
    ended = false;
  log.on('error', (error) => {
    fault = error;
  });
  child.on('error', (error) => {
    fault = error;
  });
  child.stderr.on('data', (data) => {
    fault = Error(String(data));
  });
  const closed = new Promise((resolve) =>
    child.once('close', () => {
      ended = true;
      resolve();
    })
  );
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      sample = JSON.parse(line);
      log.write(JSON.stringify(sample) + '\n');
    } catch (error) {
      fault = error;
    }
  });
  const stop = async () => {
    if (!ended) child.kill();
    await closed;
    lines.close();
    await new Promise((resolve) => log.end(resolve));
  };
  const deadline = Date.now() + 30000;
  while (!sample && !fault && !ended && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  if (!sample || fault || ended) {
    await stop();
    throw fault ?? Error('Host memory monitor did not start');
  }
  return {
    stop,
    async assertReady(attempt) {
      if (!fault && !ended && memoryReady(sample)) return;
      await writeFile(
        join(directory, 'host-memory-stop.json'),
        JSON.stringify(
          {
            attempt,
            sample,
            policy: memoryPolicy,
            error: fault ? String(fault) : null,
            reason:
              'Stopped before starting this attempt: insufficient memory reserve or unavailable telemetry. Earlier attempts remain recorded.',
          },
          null,
          2
        ) + '\n',
        { flag: 'wx' }
      );
      throw Error('Host memory preflight failed; see host-memory-stop.json');
    },
  };
}
