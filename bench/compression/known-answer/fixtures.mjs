/**
 * Workloads chosen so the right answer is arithmetic, not an observation.
 *
 * The twelve real fixtures are captured agent traffic: good for measuring an
 * engine, useless for measuring the harness, because nothing about them is
 * known in advance. Every number they produce has to be believed. These five
 * are the opposite -- each one is built around a property that can be stated
 * before anything runs and checked after, so a harness that mis-measures them
 * has no room left to be right.
 *
 *   ka-conversation    a message list. `is_messages` must route it to the
 *                      pipeline UNWRAPPED, and the capture must show the same
 *                      six messages it was given. This is the fixture the
 *                      carrier bug would have failed on day one.
 *   ka-items           a list of dicts with no `role`. Must be routed the other
 *                      way -- wrapped in the three-message tool_result envelope
 *                      -- with the payload text intact inside it.
 *   ka-identifiers     64 unique tokens, each appearing exactly once. Anything
 *                      that reads content can be scored against a count that
 *                      was fixed before the run.
 *   ka-incompressible  6 bits of entropy per byte by construction, so ~0.75
 *                      bytes of real information per byte. A lossless arm
 *                      cannot beat that; one that reports it did is offloading,
 *                      dropping, or being mis-measured. Layer 2's false-saving
 *                      detector rests on this fixture, so its premise is
 *                      verified here with deflate as the witness.
 *   ka-repeated        32 exact copies of one 256-byte block: 256 bytes of
 *                      unique content in 8192. The mirror premise -- a huge
 *                      honest reduction IS available here, so a harness that
 *                      reports none has under-measured rather than the engine
 *                      having declined.
 *
 * Nothing here uses Math.random: the generator is a fixed LCG, so two runs on
 * two machines produce identical bytes and a diff between captures can only be
 * the harness.
 */

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** A fixed LCG. Seeded explicitly so the corpus is a constant, not a sample. */
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return (state >>> 8) & 0x7fffff;
  };
}

/** `n` characters drawn uniformly from a 64-symbol alphabet: 6 bits each. */
function entropyText(n, seed) {
  const next = lcg(seed);
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[next() & 63];
  return out;
}

export const IDENTIFIER_COUNT = 64;
export const REPEAT_BLOCK_BYTES = 256;
export const REPEAT_COPIES = 32;

/** `KA-ID-0000` .. `KA-ID-0063`; fixed width so none is a prefix of another. */
export function identifiers() {
  return Array.from({ length: IDENTIFIER_COUNT }, (_, i) =>
    `KA-ID-${String(i).padStart(4, '0')}`
  );
}

export function knownAnswerFixtures() {
  const ids = identifiers();
  const block = entropyText(REPEAT_BLOCK_BYTES, 20260925);

  return [
    {
      name: 'ka-conversation',
      kind: 'messages',
      // Six turns, each carrying a sentinel that says where it sat. If the
      // carrier reorders, drops or re-wraps them, the capture says so.
      native: Array.from({ length: 6 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `KA-TURN-${i} ${entropyText(300, 41000 + i)}`,
      })),
    },
    {
      name: 'ka-items',
      kind: 'items',
      // No `role` anywhere: this must NOT be taken for a conversation.
      native: Array.from({ length: 24 }, (_, i) => ({
        id: i,
        status: i % 3 === 0 ? 'ok' : 'error',
        detail: entropyText(120, 52000 + i),
      })),
    },
    {
      name: 'ka-identifiers',
      kind: 'messages',
      ids,
      native: [
        { role: 'user', content: 'Return every record.' },
        {
          role: 'assistant',
          content: ids.map((id, i) => `${id} value=${i * 7}`).join('\n'),
        },
      ],
    },
    {
      name: 'ka-incompressible',
      kind: 'messages',
      // 6 bits per byte by construction; see the deflate witness in the check.
      entropyBitsPerChar: 6,
      native: [{ role: 'user', content: entropyText(8192, 777001) }],
    },
    {
      // THE TWO WORKLOADS WHERE NOTHING COMES BACK. A crash and a decline are
      // the cases where a harness is most tempted to write down a number
      // anyway, and both land at "their engine achieved nothing", which reads
      // as our win. These two make the capture prove it writes down neither.
      name: 'ka-declines',
      kind: 'messages',
      pipelineDeclines: true,
      native: [{ role: 'user', content: `KA-DECLINE ${entropyText(600, 90001)}` }],
    },
    {
      name: 'ka-raises',
      kind: 'messages',
      armRaises: 'ka-fragile',
      native: [{ role: 'user', content: `KA-RAISE ${entropyText(600, 90002)}` }],
    },
    {
      name: 'ka-repeated',
      kind: 'messages',
      uniqueBytes: REPEAT_BLOCK_BYTES,
      native: [{ role: 'user', content: `${block}\n`.repeat(REPEAT_COPIES) }],
    },
  ];
}
