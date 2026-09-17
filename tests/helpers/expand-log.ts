import assert from 'node:assert/strict';

/** Independent decoder for the inline formats, using no original input. */
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
        /^(.*)  \[(\d+) occurrences, positions=(\[[\d,]+\]); # = (.*)\]$/s.exec(
          line
        );
      const scattered =
        /^\[\.\.\. the same line, (\d+) more times? elsewhere; before scattered folding (\{.*\})\]$/.exec(
          line
        );
      if (templates && template) {
        const positions: number[] = JSON.parse(template[3]);
        const rows = template[4].split(' | ');
        assert.equal(rows.length, Number(template[2]));
        assert.equal(rows.length, positions.length);
        rows.forEach((row, i) => {
          const values = row.split(' ');
          let at = 0;
          const original = template[1].replace(/#/g, () => values[at++]);
          assert.equal(at, values.length);
          put(positions[i], original);
        });
      } else if (!templates && scattered) {
        const data: {
          firstPrefix: string;
          copiesAtLines: Array<[number, string]>;
        } = JSON.parse(scattered[2]);
        const first = retained.at(-1)!;
        assert(first.startsWith(data.firstPrefix));
        assert.equal(data.copiesAtLines.length, Number(scattered[1]));
        const body = first.slice(data.firstPrefix.length);
        for (const [position, prefix] of data.copiesAtLines)
          put(position, prefix + body);
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
    } else result.push(line);
  }
  return result.join('\n');
}
