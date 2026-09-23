import { expandLog } from '../helpers/expand-log.js';

/**
 * ONE ENTRY POINT FOR "REBUILD THE INPUT FROM THE OUTPUT ALONE", AND IT FAILS
 * CLOSED.
 *
 * #414 proved the log engine's `lossless: true` by reconstructing its input,
 * and left the reconstructor inside the test that needed it. Repeating that per
 * engine means one hand-written inverse per encoder, each free to drift from
 * the encoder it is supposed to invert -- and a decoder that has drifted into
 * being too forgiving passes everything, which is indistinguishable from having
 * no gate at all.
 *
 * So the envelope handling lives here once and the per-engine payload grammars
 * register into it. The envelope `[... {removed}]` / `[... {removed} -> {at}]`
 * is centralised in `src/compress/annotate.ts#inlineMarker` even though the
 * engines are not; the payload inside it is not -- `positions=` is log-specific,
 * a records template is json-specific.
 *
 * THE REFUSAL IS THE POINT. An unrecognised marker is not a line of text. A
 * decoder that passes one through as a literal reports a successful
 * reconstruction of content it never restored, which is precisely the vacuous
 * green this module exists to prevent. Two kinds of marker reach the refusal:
 * a new marker family nobody has registered, and the LOSSY form
 * `[... what went -> path]`, which by construction cannot be rebuilt from the
 * output alone -- the path is the whole point of it.
 */

/**
 * Rebuilds the original from the records encoding, rule included.
 *
 * Uniform rows are stated once as a template plus per-row fragments, and a
 * column that steps by a constant becomes a rule (`slot=first+stepN`) rather
 * than a list of values. `r-0` is then `"r-"` in the template joined to a slot
 * the rule generates: present to the byte, absent as a substring.
 */
export function expandJsonRecords(text: string): string {
  return text.replace(
    /\[JSON array records; ALL \d+ records preserved(?:, \d+ encoded here)?\. Join template parts, replacing numeric slots with verbatim text fragments from each row\. Template: (\[[^\n]+?\])(; slots ([^\]\n]+) count from 0)?\]\n([\s\S]*?)\[\/JSON fragment records\]\n/g,
    (
      _all,
      encoded: string,
      _clause,
      slots: string | undefined,
      rows: string
    ) => {
      const template = JSON.parse(encoded) as (number | string)[];
      const rules = new Map<number, { first: number; step: number }>();
      for (const part of (slots ?? '').split(' ').filter(Boolean)) {
        const m = /^(\d+)=(-?\d+)\+(-?\d+)n$/.exec(part);
        if (!m) throw new Error(`unreadable run clause ${part}`);
        rules.set(Number(m[1]), { first: Number(m[2]), step: Number(m[3]) });
      }
      return rows
        .trim()
        .split('\n')
        .map((row, index) => {
          const present = JSON.parse(row) as string[];
          const slotCount = present.length + rules.size;
          const values: string[] = [];
          let next = 0;
          for (let slot = 0; slot < slotCount; slot += 1) {
            const rule = rules.get(slot);
            values.push(
              rule ? String(rule.first + rule.step * index) : present[next++]
            );
          }
          return template
            .map((part) => (typeof part === 'number' ? values[part] : part))
            .join('');
        })
        .join('');
    }
  );
}

/** Markers this module must consume rather than pass through as text. */
const UNCONSUMED = /^\s*\[(?:JSON |All \d+ JSON )/;

/**
 * Applies every registered grammar, then refuses anything left over.
 *
 * `expandLog` already refuses an unrecognised `[... ` envelope; this adds the
 * same refusal for the json marker families, which do not use that prefix and
 * would otherwise survive as ordinary-looking lines.
 */
export function rehydrate(text: string): string {
  const out = expandLog(expandJsonRecords(text));
  for (const line of out.split('\n'))
    if (UNCONSUMED.test(line))
      throw new Error(`rehydrate: unconsumed marker ${JSON.stringify(line)}`);
  return out;
}
