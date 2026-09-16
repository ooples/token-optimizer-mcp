import {
  access,
  constants,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
import { basename, dirname, join } from 'path';

const pending = new Map<string, Promise<void>>();

/** Keep the original intact if writing, flushing, or replacing the edit fails. */
export async function replaceFile(
  path: string,
  content: string,
  encoding: BufferEncoding,
  expected: string
): Promise<void> {
  // Follow a symlink as a normal write would; do not replace the link itself.
  const target = await realpath(path);
  // Async writes must not allow two edits based on the same old content to
  // silently overwrite each other. A stale edit fails and can be re-read.
  const prior = pending.get(target) ?? Promise.resolve();
  const operation = prior
    .catch(() => {})
    .then(() => commit(target, content, encoding, expected));
  pending.set(target, operation);
  try {
    await operation;
  } finally {
    if (pending.get(target) === operation) pending.delete(target);
  }
}

async function commit(
  target: string,
  content: string,
  encoding: BufferEncoding,
  expected: string
): Promise<void> {
  // Unlike the in-process queue, exclusive creation coordinates separate MCP
  // servers. Never steal an existing lock: a paused owner may still commit.
  // A crashed owner leaves a visible, fail-closed lock for explicit recovery.
  const name =
    process.platform === 'win32'
      ? basename(target).toLowerCase()
      : basename(target);
  const key = createHash('sha256').update(name).digest('hex');
  const lockPath = join(dirname(target), `.token-optimizer-edit-${key}.lock`);
  let lock: FileHandle;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `Another edit holds ${lockPath}. Retry after it finishes. If its owner has stopped, inspect and remove the abandoned lock before retrying.`
      );
    }
    throw error;
  }
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
    );
    await commitLocked(target, content, encoding, expected);
  } finally {
    try {
      await lock.close();
    } catch {
      /* retain the commit outcome */
    }
    try {
      await unlink(lockPath);
    } catch {
      /* leave a fail-closed lock */
    }
  }
}

async function commitLocked(
  target: string,
  content: string,
  encoding: BufferEncoding,
  expected: string
): Promise<void> {
  const verify = async () => {
    if ((await stat(target)).nlink > 1) {
      throw new Error(
        'Cannot safely replace a hard-linked file. No edit was made; unlink the extra names or use a tool that explicitly supports shared-inode edits.'
      );
    }
    if ((await readFile(target, encoding)) !== expected) {
      throw new Error(
        'File changed while preparing the edit; read it again before retrying.'
      );
    }
  };
  await verify();
  await access(target, constants.W_OK);
  const mode = (await stat(target)).mode & 0o777;
  const temporary = join(
    dirname(target),
    `.token-optimizer-edit-${randomUUID()}.tmp`
  );
  let handle: FileHandle | undefined;
  let created = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    created = true;
    await writeFile(handle, content, encoding);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await verify();
    await rename(temporary, target);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* retain the original write error */
      }
    }
    if (created) {
      try {
        await unlink(temporary);
      } catch {
        /* renamed, or cleanup unavailable */
      }
    }
  }
}
