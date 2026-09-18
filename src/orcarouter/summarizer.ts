/**
 * The OrcaRouter summarizer: this package's own model calls, routed through the provider seam.
 *
 * WHY THIS ADAPTER EXISTS AT ALL. `createSummarizerFromEnv()` picks the highest-fidelity summarizer
 * whose credentials are present, and the two it shipped with speak Anthropic and Google dialects on
 * those vendors' hosts. A user who holds an OrcaRouter key has no way to make the optimizer's own
 * model calls go through the gateway they already pay for, even though OrcaRouter is
 * OpenAI-compatible and the request is a plain chat completion.
 *
 * IT TAKES A CREDENTIAL, NOT A KEY. Construction goes through `sendProviderRequest`, which resolves
 * the key from the shared credential seam, so this adapter is identical whether the user pasted a key
 * or authorized in a browser. It never reads `ORCAROUTER_API_KEY` itself and never sees a raw secret
 * in its own signature.
 *
 * THE MODEL IS NOT GUESSED. A caller supplies one from the catalog; when it does not, the model comes
 * from `TOKEN_OPTIMIZER_ORCA_MODEL`, and absent that the request is refused with an actionable
 * message rather than sent to a name nobody verified. There is no built-in default model id here for
 * the same reason the catalog filters strictly: a plausible name is not a callable model.
 */

import type { Message } from '../core/session.js';
import type { ISummarizer } from '../core/summarization.js';
import { sendProviderRequest } from './provider.js';

const SUMMARY_SYSTEM_PROMPT =
  'You are summarizing the early portion of a conversation so the rest can continue without the full history in context. ' +
  'Produce a concise summary (at most ~300 tokens) that preserves decisions made, outstanding TODOs, and any concrete facts the assistant has already told the user. ' +
  'Do not address the user directly; write in third person.';

const MAX_TOKENS = 1024;
const MAX_INPUT_CHARS = 200_000;

export interface OrcaRouterSummarizerOptions {
  /** A model id from the OrcaRouter catalog. Required unless the env var supplies one. */
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
}

export class OrcaRouterSummarizer implements ISummarizer {
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly env: NodeJS.ProcessEnv;

  public constructor(options: OrcaRouterSummarizerOptions = {}) {
    const env = options.env ?? process.env;
    this.env = env;
    this.model =
      String(options.model ?? env.TOKEN_OPTIMIZER_ORCA_MODEL ?? '').trim() ||
      '';
    if (!this.model) {
      throw new Error(
        'OrcaRouterSummarizer needs a model id: pass one from the OrcaRouter catalog, or set TOKEN_OPTIMIZER_ORCA_MODEL.'
      );
    }
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl;
  }

  public async summarize(messages: readonly Message[]): Promise<string> {
    if (messages.length === 0) return '';

    const userContent = messages
      .map((message) => `${message.role}: ${message.content}`)
      .join('\n')
      .slice(0, MAX_INPUT_CHARS);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await sendProviderRequest({
        model: this.model,
        path: '/chat/completions',
        body: {
          max_tokens: MAX_TOKENS,
          messages: [
            { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
            { role: 'user', content: userContent },
          ],
        },
        env: this.env,
        fetchImpl: this.fetchImpl,
        signal: controller.signal,
      });
      const data = response.json as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const text = data?.choices?.[0]?.message?.content;
      return typeof text === 'string' ? text.trim() : '';
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * The model the user selected for optimizer-internal calls, if any.
 *
 * Read separately from construction so `createSummarizerFromEnv()` can decide whether this adapter
 * is usable before it tries to build one.
 */
export function configuredOrcaModel(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const model = String(env.TOKEN_OPTIMIZER_ORCA_MODEL ?? '').trim();
  return model.length ? model : null;
}
