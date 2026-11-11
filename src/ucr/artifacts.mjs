import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256 } from './protocol.mjs';

export class ArtifactStore {
  constructor(root) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  pathFor(hash) {
    if (!/^[a-f0-9]{64}$/.test(String(hash)))
      throw new Error('invalid artifact hash');
    return join(this.root, hash.slice(0, 2), hash.slice(2));
  }

  put(
    content,
    { mediaType = 'application/octet-stream', sensitivity = 'internal' } = {}
  ) {
    const bytes = Buffer.isBuffer(content)
      ? content
      : Buffer.from(String(content), 'utf8');
    const hash = sha256(bytes);
    const path = this.pathFor(hash);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
      writeFileSync(
        `${path}.meta.json`,
        `${JSON.stringify({
          hash,
          bytes: bytes.length,
          mediaType,
          sensitivity,
        })}\n`,
        { flag: 'wx', mode: 0o600 }
      );
    }
    return {
      uri: `sha256:${hash}`,
      hash,
      bytes: bytes.length,
      mediaType,
      sensitivity,
    };
  }

  get(reference) {
    const hash = String(reference?.hash || reference || '').replace(
      /^sha256:/,
      ''
    );
    const path = this.pathFor(hash);
    if (!existsSync(path)) return null;
    const bytes = readFileSync(path);
    if (sha256(bytes) !== hash)
      throw new Error(`artifact integrity failure for ${hash}`);
    return bytes;
  }
}
