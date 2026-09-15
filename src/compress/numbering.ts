/**
 * A file read as an agent's tool actually delivers it: `123<TAB>line`.
 *
 * WHY THIS EXISTS, measured rather than assumed. Claude Code's `Read` prefixes
 * every line with its number and a tab, and every detector in this package was
 * written against raw file content. That prefix defeats all of them: on a
 * captured request, an 18,778-character read of a TypeScript file classified as
 * `unknown` with no engine selected at all, while the identical bytes with the
 * prefix removed classified as `code` -- and compressed 55.6%, 17,130
 * characters down to 7,604 with seven elisions, once the engine also knew the
 * path it came from.
 *
 * Those two defects compound, and either alone leaves the compressor inert:
 * without the strip nothing is classified, and without the path the code engine
 * cannot pick a language and returns its input untouched.
 *
 * THE NUMBERS ARE PUT BACK, not discarded. They are what the model uses to
 * address an edit, so handing back an unnumbered file would trade a token
 * saving for a broken edit -- the kind of bargain this package exists to refuse.
 */

/**
 * `<indent><digits><TAB><content>` — the shape a numbered read arrives in.
 *
 * `[\s\S]*` RATHER THAN `.*`, AND THAT IS NOT A STYLE CHOICE. Lines are split on
 * a newline, so a CRLF file leaves a carriage return at the end of every one.
 * `.` does not match a carriage return and `$` without the multiline flag will
 * not skip one, so `(.*)$` failed on EVERY line of a CRLF file -- detection then
 * fell below its threshold, returned null, and the content went through
 * unclassified and uncompressed.
 *
 * Caught by a wire-shaped fixture reading this repository's own sources, which
 * are CRLF: src/compress/log.ts compressed 56.3% when captured off the wire with
 * LF endings and 0.0% when read from disk. Capturing the carriage return into
 * the content group also keeps it, so restore is faithful and the file's line
 * endings survive the round trip.
 */
const NUMBERED_LINE = /^(\s*)(\d+)\t([\s\S]*)$/;

/**
 * The share of lines that must be numbered before we believe the shape.
 *
 * Not 100%: a read can carry a trailing blank line, and a truncation notice is
 * appended unnumbered. Not lower either -- a false positive here would strip
 * digits off ordinary prose that happens to start with a number, so the bar is
 * set where a genuine read clears it and a paragraph does not.
 */
const NUMBERED_SHARE = 0.8;

/** Below this there is not enough shape to be confident about. */
const MIN_LINES = 3;

export interface Numbering {
  /** The content with its line numbers removed. */
  readonly stripped: string;
  /**
   * Puts the original numbers back on the lines that survived.
   *
   * `markerBudget` is how many lines the engine was ENTITLED to invent: one per
   * elision it reported. Everything else it emits should be a line it kept
   * verbatim, because that is the assumption line-matching rests on. Passing
   * the real count is what lets this tell an added marker apart from a rewritten
   * line; omitting it assumes none and is the strictest reading.
   */
  restore(compressed: string, markerBudget?: number): string;
}

/**
 * Recognises the numbered-read shape, or reports that this is not one.
 *
 * Returns null rather than guessing for anything not clearly numbered. A false
 * positive mangles content; a false negative only leaves a saving on the table,
 * and this package has a standing rule about which of those to prefer.
 */
export function readNumbering(text: string): Numbering | null {
  const lines = text.split('\n');
  if (lines.length < MIN_LINES) return null;

  const parsed = lines.map((line) => NUMBERED_LINE.exec(line));
  const numbered = parsed.filter((m) => m !== null).length;
  if (numbered < lines.length * NUMBERED_SHARE) return null;

  const bare = parsed.map((m, i) => (m ? m[3] : lines[i]));
  const labels = parsed.map((m) => (m ? `${m[1]}${m[2]}\t` : ''));

  return {
    stripped: bare.join('\n'),
    restore(compressed: string, markerBudget = 0): string {
      // The engines remove whole lines and insert markers; they never rewrite a
      // line they keep. So walking the two in step and advancing only on a
      // match re-attaches each surviving line's ORIGINAL number, while an
      // inserted marker stays unnumbered -- which is correct, because it names
      // a range rather than occupying a line of the file.
      //
      // The scan only ever moves forward, so a line that repeats cannot pull
      // the cursor backwards and renumber the rest of the file.
      const out: string[] = [];
      let next = 0;
      let unmatched = 0;
      const lines = compressed.split('\n');
      for (const line of lines) {
        let found = -1;
        for (let i = next; i < bare.length; i += 1) {
          if (bare[i] === line) {
            found = i;
            break;
          }
        }
        if (found === -1) {
          // A line the engine INVENTED rather than kept: a marker it added,
          // or -- the case that breaks this -- a line it rewrote.
          // `compressJson` minifies a numbered, pretty-printed document into
          // one new line, which matches nothing here.
          unmatched += 1;
          out.push(line);
          continue;
        }
        out.push(`${labels[found]}${line}`);
        next = found + 1;
      }

      // FAIL CLOSED WHEN THE ASSUMPTION IS VIOLATED. This restores numbers by
      // matching whole lines, which assumes engines only ever REMOVE lines. An
      // engine that REWRITES one leaves it unmatched, and it is then emitted
      // with no number while the lines around it keep theirs -- silently
      // breaking the line addressing the numbers exist to provide, in output
      // that still reads as fully numbered.
      //
      // THE BUDGET IS THE DISCRIMINATOR, and a line-count threshold was not.
      // An engine is entitled to invent exactly one line per elision it
      // reported: that is its marker. Any unmatched line beyond that budget is
      // a retained line it rewrote -- `compressJson` minifying a document into
      // one line, or `log.ts` replacing a kept log line with a rendered
      // template. Counting those against the elisions the engine itself
      // declared distinguishes the two cases exactly, where "more than half
      // survived" merely made the failure rarer and left it silent when a
      // handful of lines were rewritten.
      if (unmatched > markerBudget) return compressed;

      return out.join('\n');
    },
  };
}
