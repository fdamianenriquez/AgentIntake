import type {
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from './types.js';

interface OpenAICompatProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/**
 * Adapter for any OpenAI-compatible /chat/completions endpoint: OpenAI,
 * OpenRouter, Groq, Together, local vLLM/Ollama, etc. Uses plain `fetch`, so
 * no provider SDK is required and every OpenAI-compatible host works.
 */
export class OpenAICompatProvider implements ModelProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(options: OpenAICompatProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
  }

  async create(request: ModelRequest): Promise<ModelResponse> {
    if (!this.apiKey) {
      throw new Error(
        `No API key configured for the OpenAI-compatible provider (${this.baseUrl}). Set AI_API_KEY in server/.env.`,
      );
    }

    const messages = [systemMessage(request.system), ...request.messages.map(toOpenAIMessage)];
    const tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxTokens,
        messages,
        tools,
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Model provider error (${response.status}) from ${this.baseUrl}: ${detail}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCallWire[] } }>;
    };

    const message = data.choices?.[0]?.message;
    const content = typeof message?.content === 'string' ? message.content.trim() : '';

    const toolCalls = (message?.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function?.name ?? '',
      arguments: safeParseJson(call.function?.arguments),
    }));

    return { content, toolCalls };
  }
}

interface ToolCallWire {
  id: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

function systemMessage(content: string): Record<string, unknown> {
  return { role: 'system', content };
}

function toOpenAIMessage(message: ModelMessage): Record<string, unknown> {
  switch (message.role) {
    case 'user':
      return { role: 'user', content: message.content };

    case 'assistant': {
      const out: Record<string, unknown> = { role: 'assistant', content: message.content };
      if (message.toolCalls && message.toolCalls.length > 0) {
        out.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        }));
      }
      return out;
    }

    case 'tool':
      return {
        role: 'tool',
        tool_call_id: message.toolCallId ?? '',
        content: message.content,
      };

    case 'system':
      return { role: 'system', content: message.content };
  }
}

function safeParseJson(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
