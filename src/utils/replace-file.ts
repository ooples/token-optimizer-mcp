import {
  access,
  constants,
  open,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import { randomUUID } from 'crypto';
import { dirname, join } from 'path';

/** Keep the original intact if writing, flushing, or replacing the edit fails. */
export async function replaceFile(
  path: string,
  content: string,
  encoding: BufferEncoding
): Promise<void> {
  // Follow a symlink as a normal write would; do not replace the link itself.
  const target = await realpath(path);
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
