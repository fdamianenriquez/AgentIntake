// Shared by the prompts (the length they ask for) and by the output schemas in
// stepEngine.ts (the length they enforce), so the two can't drift apart.

/** Longest user-facing text the invalidation check and failure classifier return. */
export const MAX_REASON_LENGTH = 240;
export const MAX_EXPLANATION_LENGTH = 300;
/**
 * The length the prompts ask for. Well under the cap, because models
 * overshoot a stated limit; the cut is only a safety net, and a sentence cut
 * mid-word is what the user would see.
 */
export const REASON_TARGET_LENGTH = 160;
export const EXPLANATION_TARGET_LENGTH = 200;
