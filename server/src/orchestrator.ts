import type { EndpointDef, FlowDef } from './flowSchema.js';
import { validateEndpointInput } from './validation.js';
import type {
  ModelMessage,
  ModelProvider,
  ModelTool,
  ToolCall,
} from './provider/types.js';

export interface ConversationResult {
  reply: string;
  isComplete: boolean;
  completedEndpoints: string[];
  totalEndpoints: number;
}

interface ConversationState {
  messages: ModelMessage[];
  completedEndpoints: string[];
}

export interface OrchestratorOptions {
  provider: ModelProvider;
}

const MAX_TOOL_ROUNDS = 10;

export function buildTools(flow: FlowDef): ModelTool[] {
  return flow.endpoints.map((endpoint) => ({
    name: endpoint.id,
    description: endpoint.description,
    inputSchema: buildInputSchema(endpoint),
  }));
}

function buildInputSchema(endpoint: EndpointDef): ModelTool['inputSchema'] {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const field of endpoint.fields) {
    const property: Record<string, unknown> = {
      type: field.type === 'enum' ? 'string' : field.type,
      description: field.description,
    };
    if (field.type === 'enum' && field.enumValues) {
      property.enum = field.enumValues;
    }
    if (field.type === 'date') {
      property.type = 'string';
      property.format = 'date';
    }
    if (field.required) {
      required.push(field.name);
    }
    properties[field.name] = property;
  }

  return { type: 'object', properties, required };
}

export function buildSystemPrompt(flow: FlowDef): string {
  const endpointList = flow.endpoints
    .map((endpoint) => {
      const fields = endpoint.fields
        .map((field) => {
          const optional = field.required ? '' : ', optional';
          const enumHint = field.enumValues ? ` (${field.enumValues.join('/')})` : '';
          return `${field.name}${optional}${enumHint}`;
        })
        .join(', ');
      return `- ${endpoint.id}: ${endpoint.description} [${fields}]`;
    })
    .join('\n');

  return [
    `You are the assistant for the "${flow.title}" intake flow.`,
    flow.description,
    '',
    'You have tools that submit collected data to backend endpoints. Call a tool only when every required field it needs has been provided by the user.',
    'Ask the user only for information that is still missing. Keep questions natural and concise; group related questions when it helps.',
    'Never invent values. If the user refuses to provide a required field, tell them which endpoint cannot be completed and what happens next.',
    'If a tool reports validation problems, ask the user to correct the invalid values and do not retry with made-up data.',
    'When all endpoints have been submitted, confirm the intake is complete and summarize what was submitted.',
    '',
    'Available endpoints:',
    endpointList,
  ].join('\n');
}

export class Orchestrator {
  private readonly provider: ModelProvider;
  private readonly sessions = new Map<string, ConversationState>();

  constructor(options: OrchestratorOptions) {
    this.provider = options.provider;
  }

  getSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  async handleTurn(
    sessionId: string,
    flow: FlowDef,
    userMessage: string,
  ): Promise<ConversationResult> {
    const state = this.getOrCreateState(sessionId);
    state.messages.push({ role: 'user', content: userMessage });

    const tools = buildTools(flow);
    const systemPrompt = buildSystemPrompt(flow);

    let reply = '';
    let round = 0;

    while (round < MAX_TOOL_ROUNDS) {
      const response = await this.provider.create({
        system: systemPrompt,
        messages: state.messages,
        tools,
        maxTokens: 1024,
      });

      state.messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
      });

      if (response.toolCalls.length === 0) {
        reply = response.content.trim();
        break;
      }

      const results = await this.runToolCalls(flow, state, response.toolCalls);
      for (const result of results) {
        state.messages.push({
          role: 'tool',
          content: result.content,
          toolCallId: result.toolCallId,
          isError: result.isError,
        });
      }
      round += 1;
    }

    return {
      reply: reply || 'The intake is still in progress. Please continue.',
      isComplete: state.completedEndpoints.length === flow.endpoints.length,
      completedEndpoints: [...state.completedEndpoints],
      totalEndpoints: flow.endpoints.length,
    };
  }

  private getOrCreateState(sessionId: string): ConversationState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { messages: [], completedEndpoints: [] };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private async runToolCalls(
    flow: FlowDef,
    state: ConversationState,
    toolCalls: ToolCall[],
  ): Promise<Array<{ toolCallId: string; content: string; isError?: boolean }>> {
    const results: Array<{ toolCallId: string; content: string; isError?: boolean }> = [];

    for (const call of toolCalls) {
      const endpoint = flow.endpoints.find((e) => e.id === call.name);

      if (!endpoint) {
        results.push({
          toolCallId: call.id,
          content: `Unknown tool "${call.name}". Choose one of: ${flow.endpoints.map((e) => e.id).join(', ')}.`,
          isError: true,
        });
        continue;
      }

      const errors = validateEndpointInput(endpoint, call.arguments);

      if (errors.length > 0) {
        results.push({
          toolCallId: call.id,
          content: `Validation failed for "${endpoint.id}": ${errors.join('; ')}. Ask the user to correct these values.`,
        });
        continue;
      }

      try {
        const result = await endpoint.execute(call.arguments);
        if (result.success) {
          if (!state.completedEndpoints.includes(endpoint.id)) {
            state.completedEndpoints.push(endpoint.id);
          }
          results.push({
            toolCallId: call.id,
            content: result.message ?? `${endpoint.id} completed successfully.`,
          });
        } else {
          results.push({
            toolCallId: call.id,
            content: result.message ?? `${endpoint.id} reported a failure.`,
          });
        }
      } catch (err) {
          results.push({
            toolCallId: call.id,
            content: `Error calling ${endpoint.id}: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          });
      }
    }

    return results;
  }
}
