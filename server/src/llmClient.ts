import { generateObject } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { z } from 'zod';

// The only file in this project allowed to import a provider SDK directly
// -- every LLM touchpoint calls generateStructured() below.
//
// "openrouter" isn't one of the three documented providers
// (anthropic | openai | google), but OpenRouter's API is OpenAI-compatible,
// so it's added here as a fourth option that reuses @ai-sdk/openai with a
// different base URL rather than pulling in a new SDK. Useful for
// development against OpenRouter's free-tier models without an Anthropic/
// OpenAI/Google key. This is
// exactly that kind of choice, called out in the pull request.
export const SUPPORTED_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter'] as const;
export type LlmProvider = (typeof SUPPORTED_PROVIDERS)[number];

const DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o-mini',
  google: 'gemini-1.5-flash',
  // "openrouter/free" is OpenRouter's own router model: it randomly selects
  // among the free models available on OpenRouter for each request, so this
  // stays a zero-cost default without pinning to one specific free model.
  // Overridable via LLM_MODEL.
  openrouter: 'openrouter/free',
};

// One variable for every provider: LLM_API_KEY is the key for whichever
// LLM_PROVIDER is selected. Exported so Studio's setup screen shares
// this single source of truth instead of a second hardcoded name.
export const API_KEY_ENV_VAR = 'LLM_API_KEY';

function isSupportedProvider(value: string): value is LlmProvider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

export function resolveProvider(): LlmProvider {
  const raw = process.env.LLM_PROVIDER ?? 'anthropic';
  if (!isSupportedProvider(raw)) {
    throw new Error(
      `Unrecognized LLM_PROVIDER "${raw}" -- expected one of: ${SUPPORTED_PROVIDERS.join(', ')}`
    );
  }
  return raw;
}

function requireApiKey(provider: LlmProvider): string {
  const key = process.env[API_KEY_ENV_VAR];
  if (!key) {
    throw new Error(
      `Set ${API_KEY_ENV_VAR} to your ${provider} API key to use LLM_PROVIDER=${provider}, or set LLM_PROVIDER to a different supported provider.`
    );
  }
  return key;
}

/** Constructs the configured provider's model. No network call happens here. */
export function buildModel(provider: LlmProvider) {
  const modelId = process.env.LLM_MODEL ?? DEFAULT_MODELS[provider];

  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey: requireApiKey(provider) })(modelId);
    case 'openai':
      // .chat() explicitly, not the default callable: as of this SDK
      // version the bare call uses OpenAI's Responses API, which
      // OpenRouter (below) does not implement.
      return createOpenAI({ apiKey: requireApiKey(provider) }).chat(modelId);
    case 'google':
      return createGoogleGenerativeAI({ apiKey: requireApiKey(provider) })(modelId);
    case 'openrouter':
      return createOpenAI({
        apiKey: requireApiKey(provider),
        baseURL: 'https://openrouter.ai/api/v1',
      }).chat(modelId);
  }
}

export interface GenerateStructuredOptions {
  /** Aborts the underlying request (not just the wait for it) after this many ms. */
  timeoutMs?: number;
}

export class LlmTimeoutError extends Error {
  override name = 'LlmTimeoutError';
}

/**
 * The single entry point every LLM touchpoint (flowGenerator, stepEngine)
 * calls. Reads LLM_PROVIDER/LLM_MODEL + the resolved provider's API key from
 * the environment, requests structured output, and returns it already
 * Zod-validated -- callers never see a raw/untrusted response.
 */
export async function generateStructured<T>(
  prompt: string,
  schema: z.ZodType<T>,
  options: GenerateStructuredOptions = {}
): Promise<T> {
  const provider = resolveProvider();
  const model = buildModel(provider);
  const abortSignal = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;

  try {
    const { object } = await generateObject({ model, schema, prompt, abortSignal });
    return object;
  } catch (error) {
    // Checked via the signal itself, not the error's shape: the SDK may wrap
    // the abort reason differently across providers and versions.
    if (abortSignal?.aborted) {
      throw new LlmTimeoutError(`The model did not respond within ${Math.round(options.timeoutMs! / 1000)} seconds.`);
    }
    throw error;
  }
}
