/**
 * The spill path every benchmark arm is handed, which is the path the proxy
 * really writes.
 *
 * Every arm used to return its own invention -- `.token-optimizer/spill/b1-block`
 * and the like -- and the marker carrying that path is part of what each arm is
 * charged for, on every turn it stays in context. Those inventions were 8 tokens
 * of path where the proxy's sink wrote about 40, so every figure that moved a
 * block under-priced our marker, and the comparison against HeadRoom's
 * `<<ccr:...>>` flattered us by exactly the part a reader cannot see.
 *
 * So the name comes from the proxy's own naming function, and the directory
 * from the canonical shape in src/compress/spill-path.ts, which is what the
 * engine's trial run prices too. The salt is fixed rather than random, because
 * the recorded token counts are keyed on the text: a path that changed between
 * runs could never have a count. Content-addressed, like the proxy, so the
 * same bytes moved twice get one path.
 */

import { createHash } from 'node:crypto';
import {
  canonicalSpillPath,
  spillName,
} from '../../dist/compress/spill-path.js';

const SALT = createHash('sha256')
  .update('token-optimizer-bench-spill')
  .digest();

/** The path the proxy would hand back for this content. */
export function benchSpillPath(content) {
  return canonicalSpillPath(spillName(SALT, content));
}
