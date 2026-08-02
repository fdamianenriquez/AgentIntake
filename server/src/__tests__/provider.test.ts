import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createModelProvider } from '../provider/index.js';
import { OpenAICompatProvider } from '../provider/openaiCompatProvider.js';
import { AnthropicProvider } from '../provider/anthropicProvider.js';
import type { ModelRequest } from '../provider/types.js';

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const request: ModelRequest = {
  system: 'You are a job intake assistant.',
  messages: [
    { role: 'user', content: 'My name is Alice.' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'submit_candidate_info', arguments: { full_name: 'Alice' } }] },
    { role: 'tool', content: 'Candidate info received.', toolCallId: 'call_1' },
  ],
  tools: [
    {
      name: 'submit_candidate_info',
      description: 'Submit candidate info.',
      inputSchema: { type: 'object', properties: { full_name: { type: 'string' } }, required: ['full_name'] },
    },
  ],
  maxTokens: 1024,
};

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock;
});

describe('OpenAICompatProvider', () => {
  it('posts OpenAI-compatible chat/completions with system + tools', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 'What is your email?', tool_calls: null } }],
      }),
    );

    const provider = new OpenAICompatProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openrouter/auto',
    });

    const result = await provider.create(request);

    expect(result).toEqual({ content: 'What is your email?', toolCalls: [] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');

    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');

    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe('openrouter/auto');
    expect(body.messages[0]).toMatchObject({ role: 'system', content: 'You are a job intake assistant.' });
    expect(body.messages[1]).toMatchObject({ role: 'user', content: 'My name is Alice.' });
    expect(body.messages[2]).toMatchObject({
      role: 'assistant',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'submit_candidate_info', arguments: JSON.stringify({ full_name: 'Alice' }) } },
      ],
    });
    expect(body.messages[3]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'Candidate info received.',
    });
    expect(body.tools[0]).toMatchObject({
      type: 'function',
      function: {
        name: 'submit_candidate_info',
        description: 'Submit candidate info.',
        parameters: request.tools[0].inputSchema,
      },
    });
  });

  it('parses tool_calls from the response', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_2',
                  type: 'function',
                  function: { name: 'submit_work_preferences', arguments: '{"desired_role":"Engineer"}' },
                },
              ],
            },
          },
        ],
      }),
    );

    const provider = new OpenAICompatProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    });

    const result = await provider.create(request);

    expect(result.toolCalls).toEqual([
      { id: 'call_2', name: 'submit_work_preferences', arguments: { desired_role: 'Engineer' } },
    ]);
  });

  it('survives malformed tool call arguments', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: 'call_3', type: 'function', function: { name: 'submit_availability', arguments: 'not-json' } },
              ],
            },
          },
        ],
      }),
    );

    const provider = new OpenAICompatProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    });

    const result = await provider.create(request);
    expect(result.toolCalls[0].arguments).toEqual({});
  });

  it('throws with a useful message on non-2xx responses', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'insufficient credits' } }, 402));

    const provider = new OpenAICompatProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    });

    await expect(provider.create(request)).rejects.toThrow('Model provider error (402)');
  });

  it('throws when no API key is configured', async () => {
    const provider = new OpenAICompatProvider({
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    });

    await expect(provider.create(request)).rejects.toThrow('No API key configured');
  });
});

describe('AnthropicProvider', () => {
  it('throws a useful error when no API key is configured', async () => {
    const provider = new AnthropicProvider({ apiKey: '', model: 'claude-3-5-haiku-latest' });

    await expect(provider.create(request)).rejects.toThrow('No API key configured');
  });
});

describe('createModelProvider', () => {
  it('defaults to the Anthropic provider', () => {
    const provider = createModelProvider({});
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it('creates an OpenAI-compatible provider for openrouter', () => {
    const provider = createModelProvider({
      provider: 'openrouter',
      apiKey: 'sk-or',
      model: 'openrouter/auto',
    });
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
  });

  it('throws for an unknown provider', () => {
    expect(() => createModelProvider({ provider: 'huggingface' })).toThrow(/Unknown AI_PROVIDER/);
  });

  it('requires a model for the openai-compatible provider', () => {
    expect(() => createModelProvider({ provider: 'openai-compatible', apiKey: 'x' })).toThrow(
      /AI_MODEL is required/,
    );
  });
});
