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
export function altAModule(env = process.env) {
  const name = (env.ALT_A_MODULE || '').trim();
  if (!name)
    throw new Error(
      "set ALT_A_MODULE to the compared package's top-level module (see bench/alt_a_alias.py)"
    );
  return name;
}

export function altACliModule(env = process.env) {
  return `${altAModule(env)}.cli`;
}

/**
 * Python that prints one attribute of the compared module, which it takes as
 * argv[1]. Every lookup goes through altAModule, so the name that starts the
 * proxy is the name whose version is recorded: reading os.environ in Python
 * instead used the untrimmed value, and the import failed after the run.
 */
export function altAAttributeScript(attribute) {
  return `import importlib, sys; print(importlib.import_module(sys.argv[1]).${attribute})`;
}
