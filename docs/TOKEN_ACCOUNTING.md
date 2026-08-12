# Token accounting contract

Token Optimizer reports four different quantities because combining them would
turn assumptions into evidence:

1. **Observed returned context** is the local tokenizer count of text that
   crossed the MCP response boundary. It is not a provider invoice.
2. **Gross verified transport reduction** is the difference between two
   materialized payloads: the tool result before progressive disclosure and
   the smaller payload actually returned.
3. **Expansion debit** is every later `expand` response linked to that preview.
4. **Net verified MCP transport avoided** is gross reduction minus expansion
   debits. It may be negative.

Graph substitutions, causal graph-reuse estimates, repository bytes scanned,
tool-reported compression fields, and legacy rows without provenance never
enter the verified MCP headline.

## Qualification rules

A reduction qualifies only when its durable row contains all of the following:

- measurement schema version 2;
- a unique MCP request identity;
- exact UTF-8 byte counts for both materialized payloads and a consistent byte
  delta;
- SHA-256 fingerprints for both payloads without storing their contents in the
  analytics row;
- locally counted tokens with `saved = before - returned`;
- the content-addressed expansion reference printed in the preview.

Request retries with the same process/session/RPC identity are stored once.
Historical rows remain available through `npm run dashboard:audit-savings` but
cannot be promoted by a boolean migration or a similarly named tool field.

## What a token means here

The MCP boundary does not expose the provider's final billing tokenizer. The
ledger therefore uses a GPT-4-compatible local tokenizer estimate so the same
transport bytes can be compared consistently across Codex, Claude Code,
Gemini, Copilot, and other clients. The dashboard says this explicitly.

Provider-native study receipts keep uncached input, cache creation, cache read,
and output fields separate when a client supplies them. Those receipt fields
are not substituted into MCP transport measurements because they answer a
different question.

## Provider usage and cost

The dashboard reads native local usage receipts from supported CLI transcripts
and keeps their billable dimensions separate: uncached input, cached reads,
5-minute/1-hour/generic cache writes, and output (including thinking tokens when
the provider bills them as output).

Adapters preserve each provider's semantics. Codex/OpenAI and Gemini prompt
totals include cached input, while Anthropic `input_tokens` excludes cache reads
and cache creation. Claude response fragments are deduplicated by request id,
and repeated Codex usage snapshots are deduplicated by cumulative state.

A versioned price catalog selects an exact provider, model, route, request
timestamp, and long-context tier. Every priced result carries an official source
link and a catalog verification date. An ambiguous id such as `claude-sonnet`,
an unknown route, or a captured dimension without a published rate remains
**Not priced**; the nearest model is never guessed.

The dashboard distinguishes two money quantities:

1. **API/list-price equivalent** applies published rates to native observed
   usage. A subscription, enterprise agreement, included credits, processing
   tier, or cloud marketplace may make the user's invoice different.
2. **Provider-reported actual charge** appears only when the native receipt
   contains a charge. Token Optimizer does not reconstruct an invoice from list
   prices.

For a verified MCP payload reduction, the conservative direct saving is one
immediate uncached-input equivalent for that operation's exact model. The ledger
does not multiply that saving by hypothetical future cache reads or writes.
Paired experiments can separately measure downstream effects from native usage.

Current provider references are the authoritative source behind catalog rows:

- [OpenAI model pricing and cached-input rates](https://developers.openai.com/api/docs/models/compare)
- [Anthropic API pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Anthropic prompt-cache usage and read/write multipliers](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Gemini API model pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [GitHub Copilot models and token pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)

The separate `analyze_project_tokens` report still accepts an explicit
`costPerMillionTokens` because repository analysis has no model request receipt.
That caller-supplied value remains labeled as a configured equivalent.

## Auditing an existing ledger

```bash
npm run dashboard:audit-savings
npm run dashboard:audit-savings -- /absolute/path/to/analytics.db
```

The audit is read-only. It reports verified net savings, gross reductions,
expansion debits, observed returned context, excluded historical/tool claims,
per-tool concentration, and the largest excluded rows.
