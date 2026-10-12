/**
 * Stored text cannot forge structure in a model's context.
 *
 * THE INJECTED BLOCK IS STRUCTURED TEXT THE MODEL READS AS FACT. It says what
 * the graph knows, one finding per line, with markers like `DISPUTED by`,
 * `STALE (...)` and `What changed:` that carry meaning. A stored value
 * containing a newline writes its own lines inside that block, and a forged
 * line is indistinguishable from a real one -- the model has no way to tell
 * which characters the renderer wrote and which came out of a record.
 *
 * AND THE VALUES ARE NOT THE GRAPH'S OWN CODE. `claim` comes from the semantic
 * harvest, which is a model reading a transcript. `contradictionReason` is
 * typed by a human through the dashboard's curate route. `staleReason` now
 * embeds a tool name taken from a hook payload. None of those is hostile by
 * default and none is trusted input either, and the distance between the two is
 * the entire reason this file exists.
 *
 * ONE CONVENTION, AT ONE BOUNDARY. The writers are many -- harvest, wiki_write,
 * the curate route, the eval harnesses -- and escaping at each of them is a rule
 * every future writer has to remember. `serve()` in staleness.mjs is the single
 * place a stored record becomes a finding handed to a model; its own docstring
 * already claims that role ("the only thing that hands a finding to a model,
 * which makes it the right place for the guarantee to live"). This is applied
 * there, once.
 *
 * DENYLIST, NOT ALLOWLIST. Every string is flattened except the few fields that
 * are multi-line by contract. The inverse -- listing the fields to flatten --
 * is a rule that silently stops covering a field the day somebody adds one, and
 * that failure mode is this repository's signature defect. A new field is safe
 * by default here, and making it multi-line takes a deliberate edit.
 */

/**
 * Characters that end a line, or that a terminal or model may treat as one.
 *
 * U+2028 and U+2029 are here because they are line terminators to JavaScript
 * and to some renderers while looking like nothing at all in a JSON payload --
 * a value that passes a `\n` check and still breaks the block.
 */
const LINE_BREAKS = /[\n\r\u2028\u2029]+/g;

/**
 * C0 controls, DEL, and C1.
 *
 * ESC (0x1B) is in this range, so ANSI colour and cursor-movement sequences go
 * with it: a stored value able to move the cursor can overwrite a line the
 * renderer wrote, which is the same forgery by a different route.
 *
 * TAB IS INCLUDED DELIBERATELY. It does not end a line, but it does shift
 * everything after it to a column the renderer did not choose, and the compact
 * surfaces (the session index, restore's "Likely next") are aligned lists where
 * that reads as structure.
 */
const CONTROLS = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * Bidirectional OVERRIDES, which reorder rendered text without changing it.
 *
 * DELIBERATELY NOT THE BIDI MARKS. U+200E/U+200F and the natural direction of
 * Arabic or Hebrew characters are how legitimate right-to-left text works, and
 * this project's own test fixtures carry an Arabic claim. Only the explicit
 * override and isolate-override controls are stripped -- the ones whose entire
 * purpose is to make the displayed order differ from the stored order.
 */
const BIDI_OVERRIDES = /[\u202A-\u202E\u2066-\u2069]/g;

/**
 * One line, whatever was stored.
 *
 * Collapses rather than deletes: a claim written as three lines stays readable
 * as one sentence instead of losing its word boundaries. Runs of whitespace
 * left behind by the collapse are squeezed, so the result does not advertise
 * how much was removed.
 */
export function safeLine(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(LINE_BREAKS, ' ')
    .replace(CONTROLS, ' ')
    .replace(BIDI_OVERRIDES, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * Fields that are multi-line by contract and must survive intact.
 *
 * `diff` is the whole point of the stale disclosure -- "STALE (...). What
 * changed:" followed by the diff -- and flattening it would destroy the
 * feature this project argues hardest for. It is a different threat in kind:
 * its content is the reader's own working tree, which the model is about to
 * read anyway, and it is already bounded in bytes and lines by `diffLines`.
 *
 * `snapshot` is stored file content for the same reason.
 */
const MULTILINE_FIELDS = new Set(['diff', 'snapshot']);

/**
 * Flattens every string on a served record, except the multi-line fields.
 *
 * Arrays of strings are flattened element-wise: `derivationChanged` carries
 * anchor paths that come from harvested findings, and a list is rendered by
 * joining it, so one element with a newline forges a line exactly as a bare
 * string would. Nested objects are left alone -- nothing on this path renders
 * one, and walking arbitrary depth would be a guess about a shape that does not
 * exist.
 */
export function safeRecord(record) {
  if (!record || typeof record !== 'object') return record;

  const out = {};
  for (const [field, value] of Object.entries(record)) {
    let safe;
    if (MULTILINE_FIELDS.has(field)) {
      safe = value;
    } else if (typeof value === 'string') {
      safe = safeLine(value);
    } else if (Array.isArray(value)) {
      safe = value.map((item) => (typeof item === 'string' ? safeLine(item) : item));
    } else {
      safe = value;
    }
    // DEFINED, NOT ASSIGNED, and this is not a style preference.
    //
    // `JSON.parse` creates `__proto__` as an ordinary own enumerable property
    // -- unlike an object literal -- so a record read from graph.jsonl can
    // carry one, and `Object.entries` above hands it over like any other field.
    // `out.__proto__ = value` then sets the PROTOTYPE of `out` instead of
    // creating a field on it, and everything on that value is inherited by the
    // served record.
    //
    // MEASURED, because it defeats this entire module rather than weakening it:
    // `safeRecord(JSON.parse('{"__proto__":{"claim":"a\nb"}}')).claim` returned
    // the claim back with its newline intact, because `render` reads
    // `finding.claim` and an inherited property answers exactly as an own one
    // does. The sanitiser ran, reported success, and the forged line went
    // through underneath it.
    //
    // `defineProperty` creates an own data property for every name including
    // `__proto__`, so the value survives as DATA -- nothing is silently dropped
    // -- and no prototype is touched.
    Object.defineProperty(out, field, {
      value: safe,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return out;
}

const QUANTIFIERS = new Set(['*', '+', '{']);
const MAX_UNBOUNDED = 4;

/** The next character after `index` that is not whitespace. */
function nextSignificant(raw, index) {
  let i = index;
  while (i < raw.length && /\s/.test(raw[i])) i++;
  return raw[i];
}

/**
 * Whether a quantifier applies to a group that repeats or branches inside it.
 *
 * THE SHAPE OF CATASTROPHIC BACKTRACKING: a group that can match the same text
 * more than one way -- because it contains a quantifier (`(a+)+`) or
 * alternatives (`(.|.)*x`, ran over ten seconds on a 29-character tool name)
 * -- under a quantifier of its own, so every split is retried.
 *
 * A SCANNER, NOT A REGEX OVER THE SOURCE. The regexes this replaced read only
 * up to the first `)`, so one more pair of parentheses hid the inner group:
 * `((a+))+` and `((.|.))*x` both passed. Here each group's frame records
 * whether anything inside it, at any depth, repeats or branches, and a closing
 * group hands that to its parent -- so the nesting depth cannot hide it.
 * Escapes and character classes are skipped, since a `(`, `|` or `+` there is
 * literal. Deliberately conservative: a false refusal only forgoes a pattern.
 */
function hasNestedRepetition(raw) {
  const frames = [];
  let inClass = false;
  // Unbounded quantifiers in sequence backtrack polynomially, to the power of
  // their count: eight `\w*` before a `!` ran past fifteen seconds on a tool
  // name, four took 18 ms. Ordinary patterns (`wiki.*write`) use one or two.
  let unbounded = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
    } else if (ch === '(') {
      frames.push(false);
    } else if (ch === ')') {
      const inner = frames.pop() === true;
      const quantified = QUANTIFIERS.has(nextSignificant(raw, i + 1));
      if (inner && quantified) return true;
      if ((inner || quantified) && frames.length) frames[frames.length - 1] = true;
    } else if (QUANTIFIERS.has(ch) || ch === '|') {
      if (ch === '*' || ch === '+' || (ch === '{' && /^\{\d*,\}/.test(raw.slice(i)))) {
        if (++unbounded > MAX_UNBOUNDED) return true;
      }
      if (frames.length) frames[frames.length - 1] = true;
    }
  }
  return false;
}

/**
 * Compiles a finding's trigger, or returns null if it is not safe to run.
 *
 * TRIGGERS ARE MODEL-SUPPLIED. The harvest writes them, and a model asked for a
 * regex can produce `(a+)+b` as readily as `\bnpx\b` -- a pattern whose
 * backtracking is exponential in the input length. That would execute on the
 * PreToolUse path against a command the user is waiting on, so a single bad
 * trigger would hang every subsequent tool call in the session. Neither a
 * try/catch nor a timeout helps: catastrophic backtracking does not throw, it
 * simply does not return.
 *
 * So the pattern is rejected before it is ever run. The test is deliberately
 * conservative -- nested quantifiers are the shape that causes this, and no
 * legitimate trigger for a command needs one.
 */
export function safeTrigger(source) {
  const raw = String(source || '');
  if (!raw || raw.length > 200) return null;

  // A quantified group that itself repeats or branches: (a+)+, (a*)*, (\d+)*,
  // (.|.)*x, and the same one parenthesis deeper, ((a+))+. See below.
  if (hasNestedRepetition(raw)) return null;

  // Stacked quantifiers outside a group, e.g. `a+*` or `.*+`.
  if (/[+*}]\s*[+*]/.test(raw)) return null;

  try {
    return new RegExp(raw, 'i');
  } catch {
    return null;
  }
}
