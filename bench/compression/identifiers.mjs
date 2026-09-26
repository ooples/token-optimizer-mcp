/**
 * THE DENOMINATOR OF EVERY RETENTION NUMBER THIS PROJECT PUBLISHES, and until
 * it was moved here it lived halfway down an 1800-line script with no way to
 * call it. "1,582 identifiers" was a figure nobody could check: not the set,
 * not the size, not the rules that admitted a member.
 *
 * It is pure -- text in, a Set of strings out -- so it can be checked against
 * inputs whose answer is known, which is what identifiers.check.mjs does. The
 * same move was made for the classification in retention.mjs, for the same
 * reason and after the same class of defect.
 */

/**
 * Things whose loss would be silent and fatal.
 *
 * THE FIRST VERSION OF THIS WAS NEARLY VACUOUS. It looked for UUIDs and hex
 * runs with `\b` boundaries and found ZERO identifiers in four of six
 * workloads -- so "zero lost" was mostly a statement about an empty set. Worse,
 * the one shape these fixtures are full of is `trace_84aa3ff0fa334b02`, and
 * `\b` does not match between `_` and `8` because both are word characters, so
 * the pattern could not see the very needles it was written for.
 *
 * This version derives the set STRUCTURALLY instead: every distinctive string
 * value in the payload, where distinctive means at least eight characters and
 * containing a digit. That catches trace ids, hostnames like `server-18`,
 * usernames, emails, paths and timestamps -- everything a later turn might
 * search for -- and excludes prose and bare small integers, which would report
 * noise as loss and make the check meaningless in the other direction.
 */
export const DISTINCTIVE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{7,}$/;

/**
 * A DECLARED SYMBOL IS A RETENTION UNIT, and MIN_SYMBOL keeps the count honest.
 *
 * Retention is scored by substring presence, so a two- or three-character name
 * matches by accident in any output long enough and would credit every arm for
 * keeping something it dropped. Five characters is where a coincidental hit
 * stops being plausible while real names still count.
 */
export const MIN_SYMBOL = 5;
const DECLARED =
  /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:class|interface|type|enum|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
const NAMED_IMPORT = /\bimport\s+(?:type\s+)?\{([^}]*)\}/g;

/**
 * A UNIT IS A TOKEN OR A SHORT PHRASE, never a document.
 *
 * The keyed rule below admits a string VALUE, and a design-prose block arrives as
 * one 18KB string value. Admitting that as a single unit would score a whole block
 * as one identifier -- almost always reported gone -- and drown the real ones. A
 * hundred and twenty characters is longer than any title, path or label in these
 * payloads and shorter than any block of them.
 */
export const MAX_UNIT = 120;

/**
 * A quoted run, with NO length bound in the pattern. The bound belongs on what
 * it captures: inside the pattern it makes the scan skip short runs and pair
 * the wrong quotes together for the remainder of the string. See the call site.
 */
export const QUOTED_RUN = /"([^"\n]*)"/g;

/**
 * Keys whose NUMERIC value names a record.
 *
 * Numbers are admitted only here, and only at four digits or more. An issue number
 * is what a later turn asks for by name; a price, a count and a byte offset are
 * not, and scoring retention by `includes` on a two-digit number finds it inside
 * any output long enough.
 */
const IDENTITY_KEY =
  /(^|_)(id|uuid|guid|sku|key|ref|number|code|hash|sha|commit|pr|issue|trace|span|event|node)$/i;

/**
 * THE TYPESCRIPT-SHAPED RULES ABOVE ARE BLIND TO STRUCTURED DATA, and two of the
 * twelve payloads scored ZERO retention units because of it -- so "0 for us, 0 for
 * them" was never a tie, it was an empty set reported as one.
 *
 * Every rule above keys on a digit-bearing token of eight characters, a markdown
 * heading, or a declaration. Measured against the captured payloads, that finds
 * nothing at all in `issue-triage` (`"number": 3000`, `"labels": ["needs-triage"]`)
 * and nothing at all in `relevance-probe` (`"id": "evt_0"`) -- and `evt_0` is the
 * needle that workload exists to find. It also misses the accessibility names in
 * `browser-session` (`name="collect digest"`) and every SKU in
 * `human-authored-json` (`"sku": "A-0"`, itself below the floor and correctly
 * still excluded).
 *
 * So two more shapes count as units, and BOTH ARE SCORED ON EVERY ARM, which is
 * what keeps this from being a thumb on the scale: on the rows where their arm
 * keeps the text and ours elides it, these rules widen THEIR column, not ours.
 *
 *   keyed  -- a string value reached under an object key, at or above MIN_SYMBOL
 *             and at or below MAX_UNIT. A value someone stored under a key is a
 *             value a later turn comes back for; the floor and the cap are what
 *             keep a coincidental substring and a whole document out.
 *   quoted -- a quoted substring inside a longer string. A tool result is one
 *             string, so an accessibility tree, a shell transcript and a log line
 *             put their names inside it rather than in a field of their own.
 */
function collect(value, into, key) {
  if (typeof value === 'string') {
    if (DISTINCTIVE.test(value) && /\d/.test(value)) into.add(value);
    // Structured content arrives as a string inside a tool result, so the
    // identifiers in it are one parse deeper than the top level.
    if (value.length > 2 && (value[0] === '{' || value[0] === '[')) {
      try {
        collect(JSON.parse(value), into, undefined);
      } catch {
        /* not nested JSON */
      }
    }
    // Free text carries them too -- a log line is one string, not a field.
    for (const word of value.split(/[\s",]+/)) {
      if (DISTINCTIVE.test(word) && /\d/.test(word)) into.add(word);
    }
    // PROSE NEEDS ITS OWN UNIT, or the check is vacuous on prose. The whole
    // identifier rule keys on "contains a digit", and a documentation heading
    // like `## API Reference: /users` contains none -- so the RAG workload
    // reported ONE identifier in 172KB and "zero lost" was a statement about
    // an almost empty set. A section heading is what a reader of a document
    // comes back for, exactly as a trace id is in a log, so distinct headings
    // are counted as retention units too.
    for (const heading of value.match(/^#{1,6} .+$/gm) || []) {
      into.add(heading.trim());
    }
    // CODE NEEDS ITS OWN UNIT FOR THE SAME REASON PROSE DID. The rule above
    // keys on "contains a digit", and a declared symbol -- `class CacheEngine`,
    // `function resolveTuning` -- almost never has one. Measured on
    // codebase-exploration, that scored two whole source blocks at ONE
    // retention unit each while they declare hundreds of symbols between them,
    // and a spill policy tuned against that count would have moved them out as
    // though nothing in them were ever asked for again. A symbol name is
    // exactly what a later turn greps for, so it is a unit.
    //
    // DECLARATIONS AND NAMED IMPORTS ONLY, never every word that looks like an
    // identifier: retention is scored with `includes`, so a short or common
    // token is found as a coincidental substring of almost any output and
    // would inflate every arm's score at once. MIN_SYMBOL is the floor that
    // makes that collision implausible while still admitting real names.
    for (const m of value.matchAll(DECLARED)) {
      if (m[1].length >= MIN_SYMBOL) into.add(m[1]);
    }
    for (const m of value.matchAll(NAMED_IMPORT)) {
      for (const part of m[1].split(',')) {
        const name = part
          .trim()
          .split(/\s+as\s+/)[0]
          .trim();
        if (name.length >= MIN_SYMBOL && /^[A-Za-z_$][\w$]*$/.test(name))
          into.add(name);
      }
    }
    // A UNIT IS SCORED BY `includes`, SO IT MUST BE A LITERAL SUBSTRING OF THE
    // TEXT IT CAME FROM -- and a multi-line value is not. Structured content is
    // one parse deeper than the block, so an issue body reached through that
    // parse holds real newlines where the block still holds the two-character
    // escape. Measured on issue-triage, that made 220 of 275 keyed units absent
    // from their own payload: unretainable by construction, charged as lost
    // against every arm at once (220 of our 265 and 220 of their 228). Every one
    // of those 220 was multi-line, and no multi-line keyed unit was ever present,
    // so the guard drops exactly the phantoms and no real name.
    if (
      key !== undefined &&
      value.length >= MIN_SYMBOL &&
      value.length <= MAX_UNIT &&
      !/[\r\n]/.test(value)
    )
      into.add(value);
    // EVERY QUOTED RUN, THEN THE LENGTH FILTER -- NOT A LENGTH FILTER INSIDE THE
    // PATTERN, which is what this line used to be and which broke the parity of
    // the scan. A payload's tool results carry JSON as a string, so this rule is
    // reading text like `{"id": 3, "user_id": 2345, "amount": -272.44}`. A
    // pattern that only matches a quoted run of five characters or more skips
    // `"id"` and then finds its next match starting at the CLOSING quote of
    // `id`, capturing `: 3, ` -- the separator between two keys -- and from
    // there it pairs every closing quote with the next opening one for the rest
    // of the value.
    //
    // Measured on agentic-conversation: 272 of the 2,428 units this rule
    // produced were separators of that shape, and 209 of them were charged
    // against the body arm as identifiers it had lost. They are unretainable by
    // construction: the unit is `: 2345, `, the value inside it IS still in the
    // output, and what went missing is the whitespace around it, which any
    // reserialisation removes. The same scan with no bound inside the pattern
    // starts each match at a real opening quote, so it captures `user_id` and
    // `amount` instead and the phantoms are never produced -- as opposed to
    // being filtered out afterwards by a rule about whitespace, which would
    // have left the wrong pairing in place everywhere else.
    for (const m of value.matchAll(QUOTED_RUN)) {
      const inner = m[1];
      if (inner.length >= MIN_SYMBOL && inner.length <= MAX_UNIT) into.add(inner);
    }
    return;
  }
  if (typeof value === 'number') {
    const digits = String(value);
    if (key !== undefined && IDENTITY_KEY.test(key) && /^\d{4,}$/.test(digits))
      into.add(digits);
    return;
  }
  if (Array.isArray(value)) {
    // THE KEY CARRIES THROUGH AN ARRAY, because `"labels": ["needs-triage"]` names
    // its members with the key, not with an index of its own.
    for (const item of value) collect(item, into, key);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, item] of Object.entries(value)) collect(item, into, k);
  }
}

/**
 * THE SCAN, WITH THE PHANTOMS IT DROPPED HANDED BACK RATHER THAN SWALLOWED.
 *
 * Every retention figure in this project is decided by `includes`: a unit
 * counts as retained when it appears in the output as a literal substring. A
 * unit that is not a literal substring of its own INPUT can therefore never be
 * counted retained by any arm, on any output, ever. It is not a retention unit;
 * it is a hole in the denominator that is charged against whoever is being
 * scored.
 *
 * That invariant was already written down at the keyed rule above, and
 * approximated there by rejecting values containing a newline. The
 * approximation is not the invariant. Measured over the eighteen captured
 * workloads, 283 of 14,067 units were not substrings of the payload they came
 * from -- 220 of the 279 on issue-triage, and, on the body arm, exactly the 8
 * on agent-loop-logs and 1 on grep-output that the harness was reporting as
 * identifiers our pipeline had lost.
 *
 * They come from nesting. A tool result carries JSON as a string, that string
 * carries a traceback with escaped newlines, and `JSON.parse` unescapes one
 * level: the unit holds a real backslash-n where the payload text holds two
 * characters more of escaping. The unit is real text at one depth and absent at
 * the depth being searched.
 *
 * So the invariant is enforced here, once, on the way out -- and the dropped
 * units are RETURNED, because a denominator that quietly shrinks is the same
 * failure as one that quietly holds phantoms.
 */
export function scanIdentifiers(text) {
  const found = new Set();
  try {
    collect(JSON.parse(text), found, undefined);
  } catch {
    collect(text, found, undefined);
  }
  const phantoms = [];
  for (const unit of found)
    if (!text.includes(unit)) {
      phantoms.push(unit);
      found.delete(unit);
    }
  return { units: found, phantoms };
}

export function identifiers(text) {
  return scanIdentifiers(text).units;
}
