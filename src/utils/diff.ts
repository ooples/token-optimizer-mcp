import { createPatch, applyPatch } from 'diff';

/**
 * Delta-based context helpers — addresses issue #122.
 *
 * Uses the unified-diff format from the existing `diff` dependency so the
 * resulting deltas are human-readable and round-trippable via applyDelta.
 */

/**
 * Compute a unified-diff delta from `previous` to `current`.
 * Returns the empty string when the inputs are identical (callers can use
 * that to skip transmitting a no-op delta).
 */
export function calculateDelta(
    previous: string,
    current: string,
    fileName: string = 'content'
): string {
    if (previous === current) {
        return '';
    }
    return createPatch(fileName, previous, current, '', '');
}

/**
 * Apply a unified-diff `delta` to `previous`, returning the reconstructed
 * `current`. Throws if the patch cannot be applied cleanly.
 */
export function applyDelta(previous: string, delta: string): string {
    if (delta === '') {
        return previous;
    }
    const result = applyPatch(previous, delta);
    if (result === false) {
        throw new Error('Failed to apply delta: patch did not apply cleanly');
    }
    return result;
}
