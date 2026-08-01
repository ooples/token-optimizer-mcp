/**
 * Quoted CSV that carries its own header row.
 *
 * `schtasks /query /fo CSV /v` is the caller. Its columns were read by fixed
 * index, which is wrong for the same reason it was wrong for wmic: the order is
 * not the one you would guess. `/v` output begins with HostName, so index 0 was
 * the machine name for every row -- see utils/wmic-csv.ts for the sibling
 * defect, and note that both survived because every CI job runs ubuntu-latest
 * and no test had ever executed either branch.
 *
 * Reading the header instead of assuming it also survives the two things that
 * actually vary in practice: a locale that renames the columns, and a schtasks
 * version that adds one.
 */

/** Splits one CSV line, honouring double-quoted fields. */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      // A doubled quote inside a quoted field is one literal quote.
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  fields.push(current);
  return fields;
}

/**
 * Parse CSV whose first line names the columns.
 *
 * @param stdout Raw command output.
 * @returns One record per data row, keyed by the LOWER-CASED column name, so
 *   lookups do not depend on the exact capitalisation a tool chose.
 */
export function parseCsvWithHeader(
  stdout: string
): Array<Record<string, string>> {
  const lines = stdout
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim());

  if (lines.length === 0) return [];

  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const rows: Array<Record<string, string>> = [];

  for (const line of lines.slice(1)) {
    const fields = splitCsvLine(line);

    // schtasks repeats the header before each folder's rows. Comparing against
    // the header we already have catches it in any locale.
    if (
      fields.length === header.length &&
      fields[0]?.trim().toLowerCase() === header[0]
    ) {
      continue;
    }

    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i++)
      row[header[i]] = (fields[i] ?? '').trim();
    rows.push(row);
  }

  return rows;
}
