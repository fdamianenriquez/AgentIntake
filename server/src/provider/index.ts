import { AnthropicProvider } from './anthropicProvider.js';
import { OpenAICompatProvider } from './openaiCompatProvider.js';
import type { ModelProvider } from './types.js';

export type { ModelProvider } from './types.js';
export { AnthropicProvider } from './anthropicProvider.js';
export { OpenAICompatProvider } from './openaiCompatProvider.js';

export const PROVIDER_NAMES = ['anthropic', 'openai', 'openrouter', 'openai-compatible'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface ProviderConfig {
  /** 'anthropic' (default), 'openai', 'openrouter', or 'openai-compatible'. */
  provider?: string;
  apiKey?: string;
  model?: string;
  /** Overrides the provider's default base URL (used by openai/openrouter/openai-compatible). */
  baseUrl?: string;
}

const DEFAULT_BASE_URLS: Partial<Record<ProviderName, string>> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  'openai-compatible': 'http://localhost:11434/v1',
};

const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: 'claude-3-5-haiku-latest',
  openai: 'gpt-4o-mini',
  openrouter: 'openrouter/auto',
  'openai-compatible': '',
};

export function createModelProvider(config: ProviderConfig = {}): ModelProvider {
  const provider = (config.provider?.toLowerCase() ?? 'anthropic') as ProviderName;

  if (!PROVIDER_NAMES.includes(provider)) {
    throw new Error(
      `Unknown AI_PROVIDER "${provider}". Use one of: ${PROVIDER_NAMES.join(', ')}.`,
    );
  }

  const model = config.model?.trim() || DEFAULT_MODELS[provider];
  if (!model) {
    throw new Error(`AI_MODEL is required for the "${provider}" provider.`);
  }

  switch (provider) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey: config.apiKey ?? '', model });
    case 'openai':
    case 'openrouter':
    case 'openai-compatible':
      return new OpenAICompatProvider({
        apiKey: config.apiKey ?? '',
        baseUrl: config.baseUrl?.trim() || DEFAULT_BASE_URLS[provider]!,
        model,
      });
  }
}
