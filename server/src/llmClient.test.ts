import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildModel, resolveProvider, SUPPORTED_PROVIDERS } from './llmClient.js';

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
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const model = buildModel('anthropic');
    expect(model.provider).toBe('anthropic.messages');
    expect(model.modelId).toBe('claude-sonnet-4-6');
  });

  it('constructs an OpenAI model using the corresponding SDK', () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const model = buildModel('openai');
    expect(model.provider).toBe('openai.chat');
    expect(model.modelId).toBe('gpt-4o-mini');
  });

  it('constructs a Google model using the corresponding SDK', () => {
    vi.stubEnv('GOOGLE_API_KEY', 'test-key');
    const model = buildModel('google');
    expect(model.provider).toBe('google.generative-ai');
    expect(model.modelId).toBe('gemini-1.5-flash');
  });

  it('constructs an OpenRouter model (via the OpenAI SDK) defaulting to the free router model', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    const model = buildModel('openrouter');
    expect(model.modelId).toBe('openrouter/free');
  });

  it('honors LLM_MODEL as an override of the per-provider default', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    vi.stubEnv('LLM_MODEL', 'claude-haiku-4-6');
    const model = buildModel('anthropic');
    expect(model.modelId).toBe('claude-haiku-4-6');
  });

  it.each([
    ['anthropic', 'ANTHROPIC_API_KEY'],
    ['openai', 'OPENAI_API_KEY'],
    ['google', 'GOOGLE_API_KEY'],
    ['openrouter', 'OPENROUTER_API_KEY'],
  ] as const)('fails fast with a clear error when %s has no API key configured', (provider, envVar) => {
    expect(() => buildModel(provider)).toThrow(new RegExp(`Set ${envVar}`));
  });
});
