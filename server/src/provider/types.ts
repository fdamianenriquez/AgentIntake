/**
 * Provider-agnostic model types. The orchestrator speaks only these types;
 * concrete adapters (Anthropic, OpenAI-compatible, ...) translate to and from
 * each provider's native wire format.
 */

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ModelMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ModelMessage {
  role: ModelMessageRole;
  /** Plain-text payload. For 'tool' messages this is the tool result. */
  content: string;
  /** Present on 'assistant' messages that requested tool calls. */
  toolCalls?: ToolCall[];
  /** Present on 'tool' messages; references the ToolCall it answers. */
  toolCallId?: string;
  /** Present on 'tool' messages; marks the result as an error. */
  isError?: boolean;
}

export interface ModelTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  tools: ModelTool[];
  maxTokens: number;
}

export interface ModelResponse {
  /** The assistant's plain-text reply (empty when only tool calls were made). */
  content: string;
  /** Tool calls the assistant requested, if any. */
  toolCalls: ToolCall[];
}

export interface ModelProvider {
  create(request: ModelRequest): Promise<ModelResponse>;
}
