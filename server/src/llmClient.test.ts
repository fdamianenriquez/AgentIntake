import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateObject: vi.fn(),
}));

import { generateObject } from 'ai';
import { buildModel, generateStructured, LlmTimeoutError, resolveProvider } from './llmClient.js';
import { SUPPORTED_PROVIDERS } from './providers.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveProvider', () => {
  it('defaults to anthropic when LLM_PROVIDER is unset', () => {
    vi.stubEnv('LLM_PROVIDER', undefined);
    expect(resolveProvider()).toBe('anthropic');
  });

  it.each(SUPPORTED_PROVIDERS)('accepts "%s" as a supported provider', (provider) => {
    vi.stubEnv('LLM_PROVIDER', provider);
    expect(resolveProvider()).toBe(provider);
  });

  it('fails fast with a clear error on an unrecognized provider', () => {
    vi.stubEnv('LLM_PROVIDER', 'anthropik');
    expect(() => resolveProvider()).toThrow(/Unrecognized LLM_PROVIDER "anthropik"/);
  });
});

describe('buildModel', () => {
  it('constructs an Anthropic model using the corresponding SDK', () => {
    vi.stubEnv('LLM_API_KEY', 'test-key');
    const model = buildModel('anthropic');
    expect(model.provider).toBe('anthropic.messages');
    expect(model.modelId).toBe('claude-sonnet-4-6');
  });

  it('constructs an OpenAI model using the corresponding SDK', () => {
    vi.stubEnv('LLM_API_KEY', 'test-key');
    const model = buildModel('openai');
    expect(model.provider).toBe('openai.chat');
    expect(model.modelId).toBe('gpt-4o-mini');
  });

  it('constructs a Google model using the corresponding SDK', () => {
    vi.stubEnv('LLM_API_KEY', 'test-key');
    const model = buildModel('google');
    expect(model.provider).toBe('google.generative-ai');
    expect(model.modelId).toBe('gemini-1.5-flash');
  });

  it('constructs an OpenRouter model (via the OpenAI SDK) defaulting to the free router model', () => {
    vi.stubEnv('LLM_API_KEY', 'test-key');
    const model = buildModel('openrouter');
    expect(model.modelId).toBe('openrouter/free');
  });

  it('honors LLM_MODEL as an override of the per-provider default', () => {
    vi.stubEnv('LLM_API_KEY', 'test-key');
    vi.stubEnv('LLM_MODEL', 'claude-haiku-4-6');
    const model = buildModel('anthropic');
    expect(model.modelId).toBe('claude-haiku-4-6');
  });

  it.each(SUPPORTED_PROVIDERS)('fails fast with a clear error when %s has no API key configured', (provider) => {
    expect(() => buildModel(provider)).toThrow(new RegExp(`Set LLM_API_KEY to your ${provider} API key`));
  });

  it('does not read the old per-provider key variables', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'old-style-key');
    expect(() => buildModel('anthropic')).toThrow(/Set LLM_API_KEY/);
  });
});

describe('generateStructured timeout', () => {
  it('aborts the underlying request and throws LlmTimeoutError when the model stalls', async () => {
    vi.stubEnv('LLM_API_KEY', 'test-key');
    let received: AbortSignal | undefined;
    vi.mocked(generateObject).mockImplementationOnce(((options: { abortSignal?: AbortSignal }) => {
      received = options.abortSignal;
      return new Promise((_, reject) => {
        options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason));
      });
    }) as never);

    await expect(generateStructured('p', z.object({}), { timeoutMs: 20 })).rejects.toBeInstanceOf(LlmTimeoutError);
    expect(received?.aborted).toBe(true);
  });

  it('passes no abort signal when no timeout is requested', async () => {
    vi.stubEnv('LLM_API_KEY', 'test-key');
    vi.mocked(generateObject).mockResolvedValueOnce({ object: { ok: true } } as never);

    await generateStructured('p', z.object({ ok: z.boolean() }));

    expect(vi.mocked(generateObject).mock.calls.at(-1)?.[0]).toMatchObject({ abortSignal: undefined });
  });

  it('rethrows non-timeout errors unchanged', async () => {
    vi.stubEnv('LLM_API_KEY', 'test-key');
    const boom = new Error('boom');
    vi.mocked(generateObject).mockRejectedValueOnce(boom);

    await expect(generateStructured('p', z.object({}), { timeoutMs: 60_000 })).rejects.toBe(boom);
  });
});
