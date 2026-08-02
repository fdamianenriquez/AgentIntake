import Anthropic from '@anthropic-ai/sdk';
import type {
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from './types.js';

interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
}

/**
 * Adapter for Anthropic Claude. The API key lives server-side only — this
 * provider is never used in the browser.
 */
export class AnthropicProvider implements ModelProvider {
  private client: Anthropic | null;
  private readonly model: string;

  constructor(options: AnthropicProviderOptions) {
    this.client = options.apiKey ? new Anthropic({ apiKey: options.apiKey }) : null;
    this.model = options.model;
  }

  async create(request: ModelRequest): Promise<ModelResponse> {
    if (!this.client) {
      throw new Error(
        'No API key configured for the Anthropic provider. Set AI_API_KEY (or ANTHROPIC_API_KEY) in server/.env.',
      );
    }

    const completion = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: toAnthropicMessages(request.messages) as unknown as Anthropic.Messages.MessageParam[],
      tools: request.tools.map(toAnthropicTool) as unknown as Anthropic.Messages.Tool[],
    });

    const text = completion.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    const toolCalls = completion.content
      .filter((block): block is Extract<typeof block, { type: 'tool_use' }> => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        name: block.name,
        arguments: block.input as Record<string, unknown>,
      }));

    return { content: text, toolCalls };
  }
}

function toAnthropicTool(tool: ModelRequest['tools'][number]): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

/**
 * Normalized history -> Anthropic messages. Consecutive 'tool' messages are
 * grouped into a single 'user' message of tool_result blocks (required so each
 * tool_result immediately follows the assistant message that called the tool).
 */
function toAnthropicMessages(messages: ModelMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let pendingToolResults: Array<Record<string, unknown>> = [];

  const flush = () => {
    if (pendingToolResults.length > 0) {
      out.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const message of messages) {
    switch (message.role) {
      case 'user':
        flush();
        out.push({ role: 'user', content: message.content });
        break;

      case 'assistant': {
        flush();
        const content: Array<Record<string, unknown>> = [];
        if (message.content) {
          content.push({ type: 'text', text: message.content });
        }
        for (const call of message.toolCalls ?? []) {
          content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
        }
        out.push({ role: 'assistant', content });
        break;
      }

      case 'tool':
        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: message.toolCallId ?? '',
          content: message.content,
          is_error: message.isError ?? false,
        });
        break;

      case 'system':
        // Handled via the top-level `system` parameter.
        break;
    }
  }

  flush();
  return out;
}
