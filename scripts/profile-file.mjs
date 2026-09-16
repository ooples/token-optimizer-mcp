import fs from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function decodeProfile(bytes) {
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    throw new Error(
      'UTF-16BE shell profiles are not supported; profile left unchanged.'
    );
  const bom = utf16
    ? 2
    : bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
      ? 3
      : 0;
  const encoding = utf16 ? 'utf16le' : 'utf8';
  const content = bytes.subarray(bom);
  const text = new TextDecoder(utf16 ? 'utf-16le' : 'utf-8', {
    fatal: true,
  }).decode(content);
  return {
    text,
    encode: (next) =>
      Buffer.concat([bytes.subarray(0, bom), Buffer.from(next, encoding)]),
  };
}

/** Installer writes must have the same failure safety as edits made by MCP. */
export function replaceProfile(path, expected, next, io = fs) {
  const target = io.existsSync(path) ? io.realpathSync(path) : path;
  io.mkdirSync(dirname(target), { recursive: true });
  const lock = `${target}.token-optimizer.lock`;
  const owner = io.openSync(lock, 'wx', 0o600);
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${randomUUID()}.tmp`
  );
  let handle;
  try {
    const verify = () => {
      const current = io.existsSync(target) ? io.readFileSync(target) : null;
      if (expected === null ? current !== null : !current?.equals(expected))
        throw new Error(`Shell profile changed during installation: ${path}`);
      if (current && io.statSync(target).nlink > 1)
        throw new Error(`Hard-linked shell profile left unchanged: ${path}`);
      if (current) io.accessSync(target, fs.constants.W_OK);
    };
    verify();
    const mode = expected === null ? 0o600 : io.statSync(target).mode & 0o777;
    handle = io.openSync(temporary, 'wx', mode);
    io.writeFileSync(handle, next);
    io.fchmodSync(handle, mode);
    io.fsyncSync(handle);
    io.closeSync(handle);
    handle = undefined;
    verify();
    io.renameSync(temporary, target);
  } finally {
    if (handle !== undefined) io.closeSync(handle);
    if (io.existsSync(temporary)) io.unlinkSync(temporary);
    io.closeSync(owner);
    io.unlinkSync(lock);
  }
}
