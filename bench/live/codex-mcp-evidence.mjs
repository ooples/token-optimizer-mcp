/** Diagnostic exposure check, separate from final artifact correctness. */
export function mcpRefreshEvidence(events, routesPath) {
  const normalize = (p) => String(p).replaceAll('\\', '/');
  let attempts = 0,
    successes = 0,
    refreshed = false,
    beforeReads = 0,
    afterReads = 0,
    cachedDiffs = 0;
  for (const event of events) {
    if (event.type !== 'item.completed') continue;
    const item = event.item;
    if (
      item?.type === 'command_execution' &&
      /\bnode(?:\.exe)?\s+["']?refresh\.mjs\b/.test(item.command || '')
    ) {
      attempts++;
      if (item.exit_code === 0) {
        successes++;
        refreshed = true;
      }
    }
    if (
      item?.type !== 'mcp_tool_call' ||
      item.server !== 'token_optimizer' ||
      item.tool !== 'smart_read' ||
      item.status !== 'completed' ||
      item.error ||
      item.result?.isError ||
      !item.result ||
      normalize(item.arguments?.path) !== normalize(routesPath)
    )
      continue;
    if (refreshed) afterReads++;
    else beforeReads++;
    for (const block of item.result.content || []) {
      try {
        const metadata = JSON.parse(block.text).metadata;
        if (
          refreshed &&
          metadata?.fromCache === true &&
          metadata?.isDiff === true
        )
          cachedDiffs++;
      } catch {}
    }
  }
  return {
    attempts,
    successes,
    beforeReads,
    afterReads,
    cachedDiffs,
    passed:
      attempts === 1 &&
      successes === 1 &&
      beforeReads > 0 &&
      afterReads > 0 &&
      cachedDiffs > 0,
  };
}
