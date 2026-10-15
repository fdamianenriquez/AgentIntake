import { APICallError, generateObject, JSONParseError, NoObjectGeneratedError, RetryError, TypeValidationError } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { z } from 'zod';
import { API_KEY_ENV_VAR, SUPPORTED_PROVIDERS, type LlmProvider } from './providers.js';

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
const DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: 'claude-haiku-5-5',
  openai: 'gpt-6-luna',
  google: 'gemini-3.8-flash',
  // "openrouter/free" is OpenRouter's own router model: it randomly selects
  // among the free models available on OpenRouter for each request, so this
  // stays a zero-cost default without pinning to one specific free model.
  // Overridable via LLM_MODEL.
  openrouter: 'openrouter/free',
};

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

/** The model a call would use: LLM_MODEL, or the provider's default. */
export function resolveModelId(provider: LlmProvider): string {
  return process.env.LLM_MODEL ?? DEFAULT_MODELS[provider];
}

/** Constructs the configured provider's model. No network call happens here. */
export function buildModel(provider: LlmProvider) {
  const modelId = resolveModelId(provider);

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
 * A short, fixed reason for a failed call -- timeout, invalid output,
 * provider error <status>, aborted or unknown -- for log lines. Decided by the
 * error's class and known properties, never its message: provider and SDK
 * error text isn't under this project's control, and some of it (a
 * type-validation error, for one) embeds the model's raw output, which can
 * echo values the user entered.
 */
export function describeLlmError(error: unknown): string {
  if (RetryError.isInstance(error)) return describeLlmError(error.lastError);
  if (error instanceof LlmTimeoutError) return 'timeout';
  if (NoObjectGeneratedError.isInstance(error) || TypeValidationError.isInstance(error) || JSONParseError.isInstance(error)) {
    return 'invalid output';
  }
  if (APICallError.isInstance(error)) return error.statusCode ? `provider error ${error.statusCode}` : 'provider error';
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  return 'unknown';
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
