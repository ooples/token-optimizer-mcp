/** Inspect the bytes Codex actually sent, including nested code-mode output. */
export function outerEnvelopeTruncated(captures) {
  for (const row of captures) {
    if (!row.path?.endsWith('/responses')) continue;
    let body;
    try {
      body = JSON.parse(row.body);
    } catch {
      continue;
    }
    for (const item of body.input || []) {
      if (
        !['function_call_output', 'custom_tool_call_output'].includes(item.type)
      )
        continue;
      const texts =
        typeof item.output === 'string'
          ? [item.output]
          : Array.isArray(item.output)
            ? item.output
                .filter((part) => part.type === 'input_text')
                .map((part) => part.text)
            : [];
      return texts.some(
        (text) =>
          typeof text === 'string' &&
          /^Warning: truncated output\b/.test(text) &&
          /\d+ tokens truncated/.test(text) &&
          /Total output lines: 1\b/.test(text) &&
          text.includes('"chunk_id":') &&
          text.includes('"output":')
      );
    }
  }
  return false;
}

export function readEvidence(captures, fixture) {
  const expected = fixture.replace(/\r\n/g, '\n');
  let complete = false,
    truncated = false,
    requests = 0;
  let firstOutputSeen = false;
  function visit(value, depth = 0) {
    if (depth > 12 || value == null) return;
    if (typeof value === 'string') {
      if (/Warning: truncated output|\d+ tokens truncated/.test(value))
        truncated = true;
      if (value.replace(/\r\n/g, '\n').includes(expected)) complete = true;
      try {
        visit(JSON.parse(value), depth + 1);
      } catch {}
    } else if (Array.isArray(value))
      for (const item of value) visit(item, depth + 1);
    else if (typeof value === 'object')
      for (const item of Object.values(value)) visit(item, depth + 1);
  }
  for (const row of captures) {
    if (!row.path?.endsWith('/responses')) continue;
    requests++;
    let body;
    try {
      body = JSON.parse(row.body);
    } catch {
      continue;
    }
    for (const item of body.input || []) {
      if (
        !firstOutputSeen &&
        ['function_call_output', 'custom_tool_call_output'].includes(item.type)
      ) {
        // Validate the controlled initial read. Later retrievals are an outcome
        // of the optimizer, and cannot retroactively invalidate a full input.
        firstOutputSeen = true;
        visit(item.output);
      }
    }
  }
  return { complete, truncated, requests };
}
