/** Explicit recovery only; normal installation never steals a profile lock. */
import fs from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function recoverProfileLock(profile, io = fs, probe = (pid) => process.kill(pid, 0)) {
  const target = io.existsSync(profile) ? io.realpathSync(profile) : resolve(profile);
  const lock = `${target}.token-optimizer.lock`;
  // Serialize explicit recovery attempts too. An abandoned recovery guard is
  // deliberately fail-closed and needs operator inspection.
  const guard = `${lock}.recovery`;
  const handle = io.openSync(guard, 'wx', 0o600);
  try {
    const identity = io.lstatSync(lock);
    if (!identity.isFile() || identity.nlink !== 1) throw Error(`Unsafe profile lock: ${lock}`);
    const snapshot = io.readFileSync(lock);
    const owner = JSON.parse(snapshot.toString('utf8'));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
        typeof owner.startedAt !== 'string' || !Number.isFinite(Date.parse(owner.startedAt)) ||
        typeof owner.nonce !== 'string' || !owner.nonce)
      throw Error(`Invalid owner metadata; inspect ${lock}`);
    try {
      probe(owner.pid);
      throw Error(`Profile lock owner ${owner.pid} is still running: ${lock}`);
    } catch (error) {
      // EPERM and PID reuse are not proof of death. Only ESRCH authorizes removal.
      if (error.code !== 'ESRCH') throw error;
    }
    const current = io.lstatSync(lock);
    if (current.dev !== identity.dev || current.ino !== identity.ino ||
        !current.isFile() || !io.readFileSync(lock).equals(snapshot))
      throw Error(`Profile lock changed during recovery: ${lock}`);
    io.unlinkSync(lock);
    return lock;
  } finally {
    io.closeSync(handle);
    io.unlinkSync(guard);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw Error('Usage: node scripts/recover-profile-lock.mjs PROFILE_PATH');
    console.log(`Recovered ${recoverProfileLock(process.argv[2])}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
