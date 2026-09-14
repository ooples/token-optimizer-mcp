/**
 * Whether a knowledge graph is advising the tree it was written about.
 *
 * ITS OWN FILE BECAUSE `findings.ts` CANNOT BE IMPORTED BY A TEST. That module
 * resolves `hooks-core` through `import.meta.url` at call time -- deliberately,
 * so a pruned runtime directory degrades to "no findings" instead of killing
 * the session -- and `import.meta` is a syntax error under the CommonJS test
 * runtime. The consequence is that nothing in `findings.ts` has ever had a unit
 * test, which is how `scope` came to be silently dropped there in the first
 * place. A pure decision with a real failure mode behind it does not belong
 * behind that wall.
 */

/**
 * Is this graph advising a tree other than the one it was written about?
 *
 * DETECTION IS NOT ENOUGH, AND THE GAP IS MEASURABLE. `isSharedDir` answers by
 * comparing the path against the machine-level unrooted graph, which catches
 * exactly one way a graph comes to span projects. It cannot catch the other: a
 * graph deliberately MOUNTED across repositories, which looks per-project from
 * the inside because its layout is identical.
 *
 * That is not hypothetical, it is how this project's own benchmark is wired.
 * The rig bind-mounts a seeded host graph at /proxy-graph and points the proxy
 * there with `--project-root`, while the tasks work on entirely different
 * upstream repositories. `isSharedDir('/proxy-graph/.token-optimizer/wiki')` is
 * false, so every `project` claim about token-optimizer-mcp was eligible for
 * injection into a Django or Cobra task under the heading "Already established
 * in this project". Measured on this repository's graph: a per-project ceiling
 * of 99,842 characters against a transferable 30,870, so 69% of what such an
 * arm could inject is advice about a tree the task never opens -- charged into
 * the cached prefix and re-read on every turn.
 *
 * So it is also DECLARABLE. Anyone mounting one graph across several trees
 * knows they are doing it; nothing in the directory can work it out. The
 * inference stays as the automatic case and the declaration is an override in
 * ONE DIRECTION ONLY -- it can say "this is shared", never "this is not".
 * A false negative here serves wrong-project claims as established fact on
 * every turn; a false positive merely withholds some true ones.
 */
export function sharedGraphFor(
  dir: string,
  wikiMod: { isSharedDir?: (dir: string) => boolean },
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const declared = env.TOKEN_OPTIMIZER_GRAPH_SHARED;
  if (declared !== undefined && /^(1|true|yes|on)$/i.test(declared.trim())) {
    return true;
  }
  // An absent or unusable `isSharedDir` means no inference is available, and
  // the safe answer is the one that changes nothing: a legitimate per-project
  // graph must not lose its project claims to a module-resolution failure.
  return typeof wikiMod.isSharedDir === 'function'
    ? wikiMod.isSharedDir(dir) === true
    : false;
}
