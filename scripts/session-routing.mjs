/** Payload-free evidence: starting a listener does not prove client routing. */
export function sessionRouting(
  client,
  write = (text) => process.stderr.write(text)
) {
  let requests = 0;
  let smaller = 0;
  let enriched = 0;
  return {
    observe(summary) {
      // Ignore telemetry, discovery and health requests. Strip only the query;
      // never print URLs, headers, prompts or provider configuration.
      const path = summary.path.split('?')[0];
      // Gemini names the model in the path and the operation after a colon, so it matches none of
      // the OpenAI- or Anthropic-shaped routes. Leaving it out did not merely miscount: a routed
      // Gemini session would end by reporting that routing was never observed.
      if (
        !/(?:\/responses|\/messages|\/chat\/completions)\/?$/.test(path) &&
        !/:(?:stream)?[Gg]enerateContent$/.test(path)
      )
        return;
      requests++;
      // The proxy's "compressed" flag also covers knowledge-only rewrites.
      // Count net byte reduction, so adding knowledge cannot masquerade as saving.
      if (summary.afterBytes < summary.beforeBytes) smaller++;
      if (summary.injectedChars > 0) enriched++;
      if (requests === 1)
        write(
          `[token-optimizer] ${client}: model request observed by session proxy.\n`
        );
    },
    finish() {
      if (!requests) {
        write(
          `[token-optimizer] ${client}: no model requests observed; proxy routing remains unverified. Client or managed settings may override routing, or this session made no model call.\n`
        );
        return;
      }
      write(
        `[token-optimizer] ${client}: ${requests} model requests observed; ${smaller} smaller payloads; ${enriched} enriched with graph knowledge. Routing evidence does not establish model success or cost savings.\n`
      );
    },
  };
}
