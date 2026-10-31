/**
 * A shell command line split at its operators, outside quotes.
 *
 * WHY THIS IS SHARED. output-compact and rewrite each split commands with a bare
 * regex over `;`, `&&`, `|`, `&` and newlines, so an operator INSIDE a quoted
 * argument split the command too. `awk 'NR>=10 && NR<=60' a.cs` became the
 * statement `NR<=60' a.cs`, which is no longer a read, so a file was folded as
 * if it were a log and an edit could be built from the folded copy.
 * `sed -n '1,20p;40,60p' a.cs` failed the same way, and rewrite's `&` split
 * turned every `2>&1` into two segments. One scanner, used by every caller, is
 * what keeps a fifth copy of the regex from reintroducing it.
 *
 * Quoting is bash's and PowerShell's common subset: '...' is literal, "..."
 * honours a backslash escape. Outside quotes a backslash escapes the next
 * character (bash); a backslash or backtick before a newline continues the line
 * (bash, PowerShell), and so does a newline after a trailing `|`.
 */

/**
 * Each top-level statement of a command, as the list of its pipeline stages,
 * quoting left in place. Statements end at `&&`, `||`, `;`, a newline, and --
 * with `background` -- a lone `&` (never the `&` of `2>&1` or `&>`).
 *
 * @param {unknown} command
 * @param {{ background?: boolean }} [options]
 * @returns {string[][]}
 */
export function shellStatements(command, { background = false } = {}) {
  const text = String(command ?? '');
  const statements = [];
  let stages = [];
  let current = '';
  let quote = '';

  const endStage = () => {
    stages.push(current.trim());
    current = '';
  };
  const endStatement = () => {
    endStage();
    const kept = stages.filter(Boolean);
    if (kept.length) statements.push(kept);
    stages = [];
  };

  // Heredoc terminators waiting for the end of the current line, in order.
  const heredocs = [];

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (quote) {
      current += c;
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && next !== undefined) {
        current += next;
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      current += c;
      continue;
    }
    // A `#` THAT STARTS A WORD begins a comment (bash and PowerShell), which runs
    // to the end of the line. Without this an apostrophe in `# the API's tests`
    // opened a quote that never closed, and every later statement -- a `cd` the
    // rewriter must see -- was swallowed into it. Mid-word (`a#b`, `$#`,
    // `${#x}`) and quoted (`'x/y#frag'`) it stays literal.
    if (c === '#' && (i === 0 || /[\s;&|(]/.test(text[i - 1]))) {
      while (i + 1 < text.length && text[i + 1] !== '\n' && text[i + 1] !== '\r') i++;
      continue;
    }
    if ((c === '\\' || c === '`') && (next === '\n' || (next === '\r' && text[i + 2] === '\n'))) {
      i += next === '\r' ? 2 : 1;
      current += ' ';
      continue;
    }
    if (c === '\\' && next !== undefined) {
      current += c + next;
      i++;
      continue;
    }
    // A HEREDOC BODY IS DATA, NOT STATEMENTS. Its lines were scanned as commands,
    // so a Python body line `head = x` read as a file read, and an apostrophe or
    // `#` in the body broke the parse of everything after it. The operator is
    // kept in its stage (`cat > f <<'EOF'`); the body, up to the terminator
    // line, is skipped when its line starts. `<<<` is a herestring, not this.
    // A herestring is consumed whole: stepping over only its first `<` left the
    // second one looking like the start of a heredoc (`<< "$x"`), and every
    // later line was skipped while waiting for a terminator that never came.
    if (c === '<' && next === '<' && text[i + 2] === '<') {
      current += '<<<';
      i += 2;
      continue;
    }
    if (c === '<' && next === '<') {
      const m = /^<<(-?)\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][\w.-]*))/.exec(text.slice(i));
      if (m) {
        heredocs.push({ word: m[2] ?? m[3] ?? m[4], tabs: m[1] === '-' });
        current += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === '\n' && heredocs.length) {
      let at = i + 1;
      for (const { word, tabs } of heredocs.splice(0)) {
        while (at < text.length) {
          let end = text.indexOf('\n', at);
          if (end === -1) end = text.length;
          let body = text.slice(at, end).replace(/\r$/, '');
          if (tabs) body = body.replace(/^\t+/, '');
          at = end + 1;
          if (body === word) break;
        }
      }
      endStatement();
      i = at - 1;
      continue;
    }
    if (c === '\r' && next === '\n') continue;
    if (c === '\n') {
      // `a |` then a newline: the pipeline goes on.
      if (!current.trim() && stages.length) continue;
      endStatement();
      continue;
    }
    if (c === ';') {
      endStatement();
      continue;
    }
    if ((c === '&' && next === '&') || (c === '|' && next === '|')) {
      endStatement();
      i++;
      continue;
    }
    if (c === '|') {
      endStage();
      continue;
    }
    if (c === '&' && background && text[i - 1] !== '>' && next !== '>') {
      endStatement();
      continue;
    }
    current += c;
  }
  // An unterminated quote keeps everything after it in the last stage.
  endStatement();
  return statements;
}

/** Every pipeline stage of every statement, in order. */
export function shellStages(command, options) {
  return shellStatements(command, options).flat();
}
