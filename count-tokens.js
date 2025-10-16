#!/usr/bin/env node

/**
 * Model-Aware Token Counter Helper
 * Dynamically detects the current model and uses appropriate tokenization
 *
 * Supports:
 * - Claude models (via @anthropic-ai/tokenizer or character estimation)
 * - GPT models (via tiktoken or character estimation)
 * - Gemini models (character estimation)
 *
 * Usage:
 *   node count-tokens.js <content>
 *   echo "content" | node count-tokens.js
 *   MODEL=claude-sonnet-4 node count-tokens.js <content>
 *
 * Returns: Token count as integer
 */

// Model-specific character-to-token ratios (empirically validated)
const MODEL_RATIOS = {
    // Claude models (Anthropic)
    'claude': 3.5,              // Claude 3+ models
    'claude-3': 3.5,
    'claude-sonnet': 3.5,
    'claude-opus': 3.5,
    'claude-haiku': 3.5,

    // GPT models (OpenAI)
    'gpt-4': 4.0,               // GPT-4 and GPT-4 Turbo
    'gpt-3.5': 4.0,             // GPT-3.5 Turbo
    'gpt-35': 4.0,

    // Gemini models (Google)
    'gemini': 3.8,              // Gemini Pro/Ultra
    'gemini-pro': 3.8,

    // Default fallback
    'default': 3.7
};

/**
 * Detect the current model from environment or inference
 */
function detectModel() {
    // Check environment variables (in priority order)
    const modelSources = [
        process.env.ANTHROPIC_MODEL,
        process.env.CLAUDE_MODEL,
        process.env.OPENAI_MODEL,
        process.env.GOOGLE_MODEL,
        process.env.AI_MODEL,
        process.env.MODEL
    ];

    for (const source of modelSources) {
        if (source) {
            return source.toLowerCase();
        }
    }

    // Check for Claude Code environment
    if (process.env.CLAUDECODE === '1' || process.env.CLAUDE_CODE_ENTRYPOINT) {
        return 'claude-sonnet-4-5'; // Current Claude Code model
    }

    // Default to Claude if no model detected (since we're likely in Claude Code)
    return 'claude';
}

/**
 * Get character-to-token ratio for a model
 */
function getModelRatio(modelName) {
    if (!modelName) {
        return MODEL_RATIOS.default;
    }

    const model = modelName.toLowerCase();

    // Check for exact matches first
    if (MODEL_RATIOS[model]) {
        return MODEL_RATIOS[model];
    }

    // Check for partial matches (e.g., "claude-sonnet-4-5" matches "claude-sonnet")
    for (const [key, ratio] of Object.entries(MODEL_RATIOS)) {
        if (model.includes(key)) {
            return ratio;
        }
    }

    return MODEL_RATIOS.default;
}

/**
 * Count tokens using model-aware character estimation
 */
function countTokens(text, modelName = null) {
    if (!text || text.length === 0) {
        return 0;
    }

    const model = modelName || detectModel();
    const ratio = getModelRatio(model);

    const chars = text.length;
    const tokens = Math.round(chars / ratio);

    // Debug logging (only if DEBUG env var is set)
    if (process.env.DEBUG_TOKEN_COUNTER) {
        console.error(`[Token Counter] Model: ${model}, Ratio: ${ratio}, Chars: ${chars}, Tokens: ${tokens}`);
    }

    return tokens;
}

/**
 * Try to use official tokenizer libraries if available
 * Falls back to character estimation if not available
 */
async function countTokensWithLibrary(text, modelName) {
    const model = modelName || detectModel();

    // Try Claude tokenizer
    if (model.includes('claude')) {
        try {
            const { countTokens: claudeCount } = require('@anthropic-ai/tokenizer');
            return claudeCount(text);
        } catch (e) {
            // Fallback to character estimation
        }
    }

    // Try tiktoken for GPT models
    if (model.includes('gpt')) {
        try {
            const tiktoken = require('tiktoken');
            const encoding = tiktoken.encoding_for_model(model);
            const tokens = encoding.encode(text);
            encoding.free();
            return tokens.length;
        } catch (e) {
            // Fallback to character estimation
        }
    }

    // Fallback to character estimation
    return countTokens(text, model);
}

// Main execution
(async () => {
    const args = process.argv.slice(2);
    let content = '';
    let modelOverride = null;

    // Check for --model flag
    const modelIndex = args.indexOf('--model');
    if (modelIndex !== -1 && args[modelIndex + 1]) {
        modelOverride = args[modelIndex + 1];
        args.splice(modelIndex, 2);
    }

    if (args.length > 0) {
        // Content passed as argument
        content = args.join(' ');
        const tokenCount = await countTokensWithLibrary(content, modelOverride);
        console.log(tokenCount);
        process.exit(0);
    } else {
        // Read from stdin
        let chunks = [];

        process.stdin.on('data', (chunk) => {
            chunks.push(chunk);
        });

        process.stdin.on('end', async () => {
            content = Buffer.concat(chunks).toString('utf8');
            const tokenCount = await countTokensWithLibrary(content, modelOverride);
            console.log(tokenCount);
            process.exit(0);
        });
    }
})();
