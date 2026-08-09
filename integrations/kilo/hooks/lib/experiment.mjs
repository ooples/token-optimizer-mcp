// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/experiment.mjs. Regenerate with `npm run sync:hooks`.
/** Explicit, reproducible feature arms and causal episode identity. */

export const EXPERIMENT_ARMS = Object.freeze([
  'baseline',
  'optimizer',
  'retrieval',
  'full',
]);

const FEATURES = Object.freeze({
  baseline: Object.freeze({ routing: false, retrieval: false, capture: false, harvest: false }),
  optimizer: Object.freeze({ routing: true, retrieval: false, capture: false, harvest: false }),
  retrieval: Object.freeze({ routing: true, retrieval: true, capture: true, harvest: false }),
  full: Object.freeze({ routing: true, retrieval: true, capture: true, harvest: true }),
});

export function experimentArm(env = process.env) {
  const requested = String(env.TOKEN_OPTIMIZER_EXPERIMENT_ARM || '').trim().toLowerCase();
  return EXPERIMENT_ARMS.includes(requested) ? requested : 'full';
}

export function featuresForArm(arm = experimentArm()) {
  return FEATURES[arm] || FEATURES.full;
}

const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');

/**
 * Normalises identifiers exposed under different names by lifecycle clients.
 * Environment overrides let the live evaluation harness pin a pair/task id
 * without asking each CLI to support experiment-specific payload fields.
 */
export function episodeMeta({ client, raw = {}, payload = {}, env = process.env } = {}) {
  const sessionId = String(first(
    payload.session_id, raw.session_id, raw.sessionId, raw.conversation_id,
    raw.conversationId, raw.taskId, raw.task_id, raw.trajectory_id, 'default'
  ));
  const episodeId = String(first(
    env.TOKEN_OPTIMIZER_EPISODE_ID, raw.episode_id, raw.episodeId, sessionId
  ));
  const toolCallId = first(
    raw.tool_use_id, raw.toolUseId, raw.tool_call_id, raw.toolCallId,
    raw.call_id, raw.callId, raw.postToolUse?.toolUseId, raw.preToolUse?.toolUseId
  );
  const model = first(payload.model, raw.model?.slug, raw.model, raw.model_name, env.TOKEN_OPTIMIZER_MODEL);
  const clientVersion = first(
    raw.client_version, raw.clientVersion, raw.version, env.TOKEN_OPTIMIZER_CLIENT_VERSION
  );
  const modelVersion = first(raw.model_version, raw.modelVersion, env.TOKEN_OPTIMIZER_MODEL_VERSION);

  return {
    schemaVersion: 2,
    episodeId,
    sessionId,
    turnId: first(raw.turn_id, raw.turnId, raw.message_id, raw.messageId) ?? null,
    toolCallId: toolCallId == null ? null : String(toolCallId),
    taskId: first(env.TOKEN_OPTIMIZER_TASK_ID, raw.task_id, raw.taskId) ?? null,
    pairId: first(env.TOKEN_OPTIMIZER_PAIR_ID, raw.pair_id, raw.pairId) ?? null,
    arm: experimentArm(env),
    client: String(client || first(raw.client, raw.client_name, 'unknown')),
    clientVersion: clientVersion == null ? null : String(clientVersion),
    model: model == null ? null : String(model),
    modelVersion: modelVersion == null ? null : String(modelVersion),
  };
}

export function usageFrom(raw = {}) {
  const usage = raw.usage || raw.token_usage || raw.tokenUsage || raw.metrics?.usage || {};
  const number = (...values) => {
    const value = first(...values);
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  return {
    uncachedInputTokens: number(usage.uncached_input_tokens, usage.uncachedInputTokens),
    cachedInputTokens: number(usage.cached_input_tokens, usage.cachedInputTokens, usage.cache_read_input_tokens),
    outputTokens: number(usage.output_tokens, usage.outputTokens),
    totalTokens: number(usage.total_tokens, usage.totalTokens, raw.tokens_used, raw.tokensUsed),
  };
}
