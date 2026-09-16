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
import { randomUUID } from 'crypto';
import { dirname, join } from 'path';

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
  const verify = async () => {
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
