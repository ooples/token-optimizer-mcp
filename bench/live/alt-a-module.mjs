/**
 * The compared package's CLI module, for `python -m`.
 *
 * The scripts refer to the compared package by a neutral name, and Python code
 * resolves that name through bench/alt_a_alias.py. `python -m` cannot use the
 * alias: the interpreter looks the module up before any script runs, so
 * `python -m alternative_a.cli` failed with "No module named alternative_a" and
 * every competitor arm that spawned it started no proxy. The real module comes
 * from ALT_A_MODULE, the same variable the alias reads.
 */
export function altACliModule(env = process.env) {
  const name = (env.ALT_A_MODULE || '').trim();
  if (!name)
    throw new Error(
      "set ALT_A_MODULE to the compared package's top-level module (see bench/alt_a_alias.py)"
    );
  return `${name}.cli`;
}
