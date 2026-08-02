import { describe, expect, it, vi } from 'vitest';
import { Orchestrator, buildSystemPrompt, buildTools } from '../orchestrator.js';
import { jobApplicationIntakeFlow } from '../flows/exampleFlow.js';
import type { ModelMessage, ModelProvider, ModelRequest, ModelResponse } from '../provider/types.js';
import type { FlowDef } from '../flowSchema.js';

class ScriptedClient implements ModelProvider {
  private index = 0;
  messagesSeen: ModelMessage[][] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async create(params: ModelRequest) {
    this.messagesSeen.push(params.messages.slice());
    const response = this.responses[this.index++];
    if (!response) {
      throw new Error('No more scripted responses');
    }
    return response;
  }
}

function candidateFlow(execute = vi.fn(async () => ({ success: true }))): FlowDef {
  return {
    ...jobApplicationIntakeFlow,
    endpoints: jobApplicationIntakeFlow.endpoints.map((endpoint) =>
      endpoint.id === 'submit_candidate_info' ? { ...endpoint, execute } : endpoint,
    ),
  };
}

const validCandidate = {
  full_name: 'Alice Smith',
  email: 'alice@example.com',
  years_of_experience: 3,
  current_location: 'New York, NY',
};

describe('buildTools', () => {
  it('maps endpoints to provider-agnostic tool definitions', () => {
    const tools = buildTools(jobApplicationIntakeFlow);
    expect(tools.map((t) => t.name)).toEqual([
      'submit_candidate_info',
      'submit_work_preferences',
      'submit_availability',
    ]);

    const candidate = tools.find((t) => t.name === 'submit_candidate_info')!;
    expect(candidate.inputSchema.required).toContain('full_name');
    expect(candidate.inputSchema.required).toContain('email');
    expect(candidate.inputSchema.properties.full_name).toMatchObject({ type: 'string' });
    expect(candidate.inputSchema.properties.email).toMatchObject({
      type: 'string',
      description: 'The candidate email address.',
    });
    expect(candidate.inputSchema.properties.years_of_experience).toMatchObject({ type: 'number' });

    const prefs = tools.find((t) => t.name === 'submit_work_preferences')!;
    expect(prefs.inputSchema.properties.work_arrangement).toMatchObject({
      type: 'string',
      enum: ['remote', 'hybrid', 'onsite'],
    });

    const availability = tools.find((t) => t.name === 'submit_availability')!;
    expect(availability.inputSchema.properties.earliest_start_date).toMatchObject({
      type: 'string',
      format: 'date',
    });
  });
});

describe('buildSystemPrompt', () => {
  it('describes the flow and its endpoints', () => {
    const prompt = buildSystemPrompt(jobApplicationIntakeFlow);
    expect(prompt).toContain('Job Application Intake');
    expect(prompt).toContain('submit_candidate_info');
    expect(prompt).toContain('submit_work_preferences');
    expect(prompt).toContain('submit_availability');
  });
});

describe('Orchestrator.handleTurn', () => {
  it('returns a plain assistant reply when the model makes no tool call', async () => {
    const client = new ScriptedClient([{ content: 'Hello! What can I help with?', toolCalls: [] }]);
    const orchestrator = new Orchestrator({ provider: client });

    const result = await orchestrator.handleTurn('s1', jobApplicationIntakeFlow, 'hi');

    expect(result.reply).toBe('Hello! What can I help with?');
    expect(result.isComplete).toBe(false);
    expect(result.completedEndpoints).toEqual([]);
    expect(result.totalEndpoints).toBe(3);
  });

  it('feeds validation errors back and only calls execute on valid data', async () => {
    const execute = vi.fn(async () => ({ success: true }));
    const flow = candidateFlow(execute);

    const invalid = { ...validCandidate, email: 'not-an-email' };
    const client = new ScriptedClient([
      {
        content: '',
        toolCalls: [{ id: 't1', name: 'submit_candidate_info', arguments: invalid }],
      },
      {
        content: '',
        toolCalls: [{ id: 't2', name: 'submit_candidate_info', arguments: validCandidate }],
      },
      { content: 'Candidate info submitted. What about work preferences?', toolCalls: [] },
    ]);
    const orchestrator = new Orchestrator({ provider: client });

    const result = await orchestrator.handleTurn(
      's1',
      flow,
      'Alice Smith, alice@example.com, 3 years, NYC',
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(validCandidate);

    expect(result.completedEndpoints).toEqual(['submit_candidate_info']);
    expect(result.isComplete).toBe(false);
    expect(result.reply).toContain('work preferences');

    const secondCallMessages = client.messagesSeen[1];
    const lastMessage = secondCallMessages[secondCallMessages.length - 1];
    expect(lastMessage).toMatchObject({
      role: 'tool',
      content: expect.stringContaining('Validation failed'),
    });
  });

  it('does not execute when validation fails', async () => {
    const execute = vi.fn(async () => ({ success: true }));
    const flow = candidateFlow(execute);

    const invalid = { full_name: 'A', email: 'nope', years_of_experience: 3, current_location: 'NYC' };
    const client = new ScriptedClient([
      {
        content: '',
        toolCalls: [{ id: 't1', name: 'submit_candidate_info', arguments: invalid }],
      },
      { content: 'Please correct your name and email.', toolCalls: [] },
    ]);
    const orchestrator = new Orchestrator({ provider: client });

    const result = await orchestrator.handleTurn('s1', flow, 'my details');

    expect(execute).not.toHaveBeenCalled();
    expect(result.completedEndpoints).toEqual([]);
    expect(result.isComplete).toBe(false);
  });

  it('marks the flow complete when all endpoints have executed', async () => {
    const singleEndpointFlow: FlowDef = {
      id: 'single',
      title: 'Single',
      description: 'One endpoint.',
      endpoints: [
        {
          id: 'only_endpoint',
          description: 'The only endpoint.',
          fields: [{ name: 'value', type: 'string', description: 'a value', required: true }],
          execute: async () => ({ success: true }),
        },
      ],
    };

    const client = new ScriptedClient([
      {
        content: '',
        toolCalls: [{ id: 't1', name: 'only_endpoint', arguments: { value: 'hello' } }],
      },
      { content: 'All done!', toolCalls: [] },
    ]);
    const orchestrator = new Orchestrator({ provider: client });

    const result = await orchestrator.handleTurn('s1', singleEndpointFlow, 'hello');

    expect(result.isComplete).toBe(true);
    expect(result.completedEndpoints).toEqual(['only_endpoint']);
    expect(result.reply).toBe('All done!');
  });

  it('handles an unknown tool name without executing anything', async () => {
    const execute = vi.fn(async () => ({ success: true }));
    const flow = candidateFlow(execute);

    const client = new ScriptedClient([
      { content: '', toolCalls: [{ id: 't1', name: 'nonexistent_tool', arguments: {} }] },
      { content: 'No such endpoint.', toolCalls: [] },
    ]);
    const orchestrator = new Orchestrator({ provider: client });

    const result = await orchestrator.handleTurn('s1', flow, 'go');

    expect(execute).not.toHaveBeenCalled();
    expect(result.completedEndpoints).toEqual([]);
  });

  it('preserves state across turns for the same session', async () => {
    const execute = vi.fn(async () => ({ success: true }));
    const flow = candidateFlow(execute);

    const client = new ScriptedClient([
      {
        content: '',
        toolCalls: [{ id: 't1', name: 'submit_candidate_info', arguments: validCandidate }],
      },
      { content: 'Candidate info submitted.', toolCalls: [] },
      { content: 'What are your work preferences?', toolCalls: [] },
    ]);
    const orchestrator = new Orchestrator({ provider: client });

    const first = await orchestrator.handleTurn('s1', flow, 'my details');
    const second = await orchestrator.handleTurn('s1', flow, 'remote');

    expect(first.completedEndpoints).toEqual(['submit_candidate_info']);
    expect(second.completedEndpoints).toEqual(['submit_candidate_info']);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('isolates state across different sessions', async () => {
    const execute = vi.fn(async () => ({ success: true }));
    const flow = candidateFlow(execute);

    const client = new ScriptedClient([
      {
        content: '',
        toolCalls: [{ id: 't1', name: 'submit_candidate_info', arguments: validCandidate }],
      },
      { content: 'Candidate info submitted.', toolCalls: [] },
      { content: 'What are your work preferences?', toolCalls: [] },
    ]);
    const orchestrator = new Orchestrator({ provider: client });

    await orchestrator.handleTurn('session-a', flow, 'my details');
    const other = await orchestrator.handleTurn('session-b', flow, 'remote');

    expect(other.completedEndpoints).toEqual([]);
  });
});
