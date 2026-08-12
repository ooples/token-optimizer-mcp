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

## Cost equivalents

There is no universal dollars-per-token conversion. The bill can depend on the
provider, model, long-context threshold, processing tier, cache read/write mix,
subscription or API route, enterprise agreement, included credits, and local
taxes. A saved context token may also have zero marginal cash value under an
included plan until an allowance boundary is crossed.

For that reason the dashboard and CLI audits render **Not priced** by default.
To show a cost equivalent, configure a rate that already reflects your own
effective blended input cost:

```bash
TOKEN_OPTIMIZER_EFFECTIVE_INPUT_USD_PER_MILLION=2.25 npm run dashboard
```

The displayed formula is:

```text
cost equivalent = net verified MCP transport avoided / 1,000,000 × configured rate
```

It remains a cost equivalent, not a reconstructed invoice. Use the provider's
own usage and billing export for actual spend.

The contract deliberately does not ship a model price table. Prices and billing
units change, and CLI products can route through subscriptions, direct APIs,
cloud marketplaces, enterprise agreements, or included-credit plans. Current
provider references are the authoritative source:

- [OpenAI model pricing and cached-input rates](https://developers.openai.com/api/docs/models/compare)
- [Anthropic API pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Anthropic prompt-cache usage and read/write multipliers](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Gemini context caching and cached-token usage](https://ai.google.dev/gemini-api/docs/caching)
- [GitHub Copilot billing, plans, and premium requests](https://docs.github.com/en/billing/concepts/product-billing/github-copilot-billing)

The separate `analyze_project_tokens` report follows the same rule. Its cost
fields are `null` unless the caller explicitly supplies
`costPerMillionTokens`; when supplied, they are labeled as a configured cost
equivalent rather than a provider invoice.

## Auditing an existing ledger

```bash
npm run dashboard:audit-savings
npm run dashboard:audit-savings -- /absolute/path/to/analytics.db
```

The audit is read-only. It reports verified net savings, gross reductions,
expansion debits, observed returned context, excluded historical/tool claims,
per-tool concentration, and the largest excluded rows.
