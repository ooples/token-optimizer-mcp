import assert from 'node:assert/strict';
import { PathAddressedError, decodeGaps, pathAddressed } from './annotate.js';

/** Independent decoder for the inline formats, using no original input. */
/**
 * Undoes the value encoding the template writer applies.
 *
 * ORDER IS THE WHOLE CORRECTNESS ARGUMENT. `%25` is decoded LAST, so a value
 * that really contained the text `%20` -- written out as `%2520` -- comes back
 * as `%20` and not as a space. Decoding `%25` first would turn it into `%20`
 * and then into a space, which is a silent corruption rather than a failure.
 */
function decodeValue(value: string): string {
  return value
    .replace(/%20/g, ' ')
    .replace(/%09/g, '	')
    .replace(/%7C/g, '|')
    .replace(/%25/g, '%');
}

export function expandLog(text: string): string {
  function restoreIndexed(lines: string[], templates: boolean): string[] {
    const retained: string[] = [];
    const restored = new Map<number, string>();
    const put = (position: number, line: string) => {
      assert(
        Number.isInteger(position) && position > 0 && !restored.has(position)
      );
      restored.set(position, line);
    };
    for (const line of lines) {
      const template =
        /^(.*)  \[(\d+) occurrences, (positions|gaps)=(\[[\d,*]*\]); # = (.*)\]$/s.exec(
          line
        );
      // FAIL CLOSED ON A TEMPLATE THIS DECODER CANNOT READ. A grammar change
      // inside the brackets -- absolute positions became gaps here -- makes the
      // match above fail, and without this the line falls through to
      // `retained.push` and is reported as one ordinary log line. Every
      // occurrence it stood for is then missing from a reconstruction that
      // claims to have succeeded. A shape that announces itself as a template
      // and does not parse is an error, not a line.
      if (templates && !template && / {2}\[\d+ occurrences, /.test(line))
        throw new Error(
          `expandLog: unreadable template ${JSON.stringify(line.slice(0, 120))}`
        );
      const scattered =
        /^\[\.\.\. the same line, (\d+) more times? elsewhere; before scattered folding (\{.*\})\]$/.exec(
          line
        );
      if (templates && template) {
        const positions: number[] =
          template[3] === 'gaps'
            ? decodeGaps(template[4])
            : JSON.parse(template[4]);
        const rows = template[5].split(' | ');
        assert.equal(rows.length, Number(template[2]));
        assert.equal(rows.length, positions.length);
        rows.forEach((row, i) => {
          const values = row.split(' ').map(decodeValue);
          let at = 0;
          const original = template[1].replace(/#/g, () => values[at++]);
          assert.equal(at, values.length);
          put(positions[i], original);
        });
      } else if (!templates && scattered) {
        const data: {
          firstPrefix: string;
          // Absent on anything written before the shared lead was factored out,
          // and on a group whose prefixes share too little for it to pay.
          lead?: string;
          copiesAtLines: Array<[number, string]>;
        } = JSON.parse(scattered[2]);
        const lead = data.lead ?? '';
        const first = retained.at(-1)!;
        assert(first.startsWith(data.firstPrefix));
        assert.equal(data.copiesAtLines.length, Number(scattered[1]));
        const body = first.slice(data.firstPrefix.length);
        for (const [position, prefix] of data.copiesAtLines)
          put(position, lead + prefix + body);
      } else retained.push(line);
    }
    const result: string[] = [];
    const length = retained.length + restored.size;
    let at = 0;
    for (let position = 1; position <= length; position++)
      result.push(restored.get(position) ?? retained[at++]);
    assert.equal(at, retained.length);
    assert(result.every((line) => typeof line === 'string'));
    return result;
  }
  const lines = restoreIndexed(restoreIndexed(text.split('\n'), true), false);
  const result: string[] = [];
  for (const line of lines) {
    const period =
      /^\[\.\.\. previous (\d+) log lines repeat (\d+) more times, verbatim and in order\]$/.exec(
        line
      );
    const adjacent =
      /^\[\.\.\. the same line, (\d+) more times?(?: with prefix replacements (\{.*\}))?\]$/.exec(
        line
      );
    if (period) {
      const block = result.slice(-Number(period[1]));
      for (let n = 0; n < Number(period[2]); n++) result.push(...block);
    } else if (adjacent) {
      const first = result.at(-1)!;
      if (!adjacent[2])
        for (let n = 0; n < Number(adjacent[1]); n++) result.push(first);
      else {
        const data: { firstPrefix: string; copies: string[] } = JSON.parse(
          adjacent[2]
        );
        assert(first.startsWith(data.firstPrefix));
        assert.equal(data.copies.length, Number(adjacent[1]));
        result.push(
          ...data.copies.map(
            (prefix) => prefix + first.slice(data.firstPrefix.length)
          )
        );
      }
    } else if (line.trimStart().startsWith('[... ')) {
      // FAIL CLOSED. A marker this decoder does not know is not a line,
      // and passing it through as one silently reports a successful
      // reconstruction of content it never restored. Two cases reach here:
      // a new marker family nobody taught it, and the LOSSY form
      // `[... what went -> path]`, which by construction cannot be
      // rebuilt from the output alone -- the path is the whole point.
      //
      // BOTH REFUSE, BUT THEY ARE NOT THE SAME FACT. The second is the design
      // working and its content is one `Read` away; the first is a gap. Sharing
      // one error type meant a caller had to tell them apart by matching on
      // message text, so the head-to-head harness filed six by-design refusals
      // on a queue meant for defects. The path travels with the refusal now.
      const at = pathAddressed(line);
      if (at !== null) throw new PathAddressedError(at);
      throw new Error(`expandLog: unrecognised marker ${JSON.stringify(line)}`);
    } else result.push(line);
  }
  return result.join('\n');
}
