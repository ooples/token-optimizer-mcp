// Import the compiler-backed implementation only when its tool is invoked.
export * from './analysis-tool-definitions.js';

export async function runSmartComplexity(
  ...args: Parameters<typeof import('./smart-complexity.js').runSmartComplexity>
): Promise<
  Awaited<ReturnType<typeof import('./smart-complexity.js').runSmartComplexity>>
> {
  const tool = await import('./smart-complexity.js');
  return tool.runSmartComplexity(...args);
}

export async function runSmartExports(
  ...args: Parameters<typeof import('./smart-exports.js').runSmartExports>
): Promise<
  Awaited<ReturnType<typeof import('./smart-exports.js').runSmartExports>>
> {
  const tool = await import('./smart-exports.js');
  return tool.runSmartExports(...args);
}

export async function runSmartImports(
  ...args: Parameters<typeof import('./smart-imports.js').runSmartImports>
): Promise<
  Awaited<ReturnType<typeof import('./smart-imports.js').runSmartImports>>
> {
  const tool = await import('./smart-imports.js');
  return tool.runSmartImports(...args);
}

export async function runSmartRefactor(
  ...args: Parameters<typeof import('./smart-refactor.js').runSmartRefactor>
): Promise<
  Awaited<ReturnType<typeof import('./smart-refactor.js').runSmartRefactor>>
> {
  const tool = await import('./smart-refactor.js');
  return tool.runSmartRefactor(...args);
}

export async function runSmartSymbols(
  ...args: Parameters<typeof import('./smart-symbols.js').runSmartSymbols>
): Promise<
  Awaited<ReturnType<typeof import('./smart-symbols.js').runSmartSymbols>>
> {
  const tool = await import('./smart-symbols.js');
  return tool.runSmartSymbols(...args);
}

export async function runSmartTypescript(
  ...args: Parameters<typeof import('./smart-typescript.js').runSmartTypescript>
): Promise<
  Awaited<ReturnType<typeof import('./smart-typescript.js').runSmartTypescript>>
> {
  const tool = await import('./smart-typescript.js');
  return tool.runSmartTypescript(...args);
}
