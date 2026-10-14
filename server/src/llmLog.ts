import { createHash } from 'node:crypto';
import { GUIDANCE_BLOCK_VERSION, renderGuidance, type PromptCall, type PromptGuidance } from './prompts/guidance.js';
import { logger } from './logger.js';

// What a log line may say about an LLM call (README: "Logging"): which call, which
// prompt and guidance-block versions, and a short hash of the guidance block
// -- enough to tie a spike in fallbacks to a guidance or prompt change.
// Never the guidance text, the prompt, the submitted data or a field value.

/** First 12 hex characters of the rendered guidance block's sha256, or "none". */
export function guidanceHash(guidance: PromptGuidance | undefined): string {
  const block = renderGuidance(guidance);
  return block ? createHash('sha256').update(block).digest('hex').slice(0, 12) : 'none';
}

export interface LlmCallMeta {
  call: PromptCall;
  promptVersion: number;
  guidance: PromptGuidance | undefined;
}

/** `call=… prompt=v… guidanceBlock=v… guidance=…`, for log lines. */
export function describeCall({ call, promptVersion, guidance }: LlmCallMeta): string {
  return `call=${call} prompt=v${promptVersion} guidanceBlock=v${GUIDANCE_BLOCK_VERSION} guidance=${guidanceHash(guidance)}`;
}

/** Runs one model call, logging a debug line with its outcome and duration. */
export async function loggedLlmCall<T>(meta: LlmCallMeta, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const line = (outcome: string) =>
    logger.debug(`llm ${describeCall(meta)} outcome=${outcome} duration=${Math.round(performance.now() - started)}ms`);
  try {
    const result = await fn();
    line('ok');
    return result;
  } catch (error) {
    line('degraded');
    throw error;
  }
}
