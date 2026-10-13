import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { ParsedEndpoint } from '../../../packages/react-agent-intake/src/contracts.js';

vi.mock('../llmClient.js', () => ({
  generateStructured: vi.fn(),
}));

vi.mock('../stepEngine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stepEngine.js')>();
  return { ...actual, selectStepFields: vi.fn(actual.selectStepFields) };
});

import { generateStructured } from '../llmClient.js';
import { selectStepFields } from '../stepEngine.js';
import { createApp } from '../app.js';
import { getOrCreateSession, getSession, recordValidatedStep } from '../sessionStore.js';

const mockedGenerateStructured = vi.mocked(generateStructured);
const mockedSelectStepFields = vi.mocked(selectStepFields);

const endpoint: ParsedEndpoint = {
  id: 'createCandidate',
  title: 'Your Details',
  fields: [
    { name: 'email', type: 'string', label: 'Email', required: true },
    { name: 'yearsOfExperience', type: 'number', label: 'Years of experience', required: false },
  ],
  auth: { type: 'none' },
};

beforeEach(() => {
  mockedGenerateStructured.mockReset();
});

describe('POST /api/step/fields', () => {
  it('returns the LLM-adapted fields and creates a session under the given id', async () => {
    mockedGenerateStructured.mockResolvedValueOnce({
      fields: [{ name: 'email' }],
      suggestedValues: [],
    });

    const sessionId = 'route-test-session-1';
    const response = await request(createApp())
      .post('/api/step/fields')
      .send({ sessionId, endpoint });

    expect(response.status).toBe(200);
    expect(response.body.fields.map((f: { name: string }) => f.name)).toEqual(['email']);
    expect(response.body.degraded).toBe(false);
    expect(getSession(sessionId)).toBeDefined();
  });

  it('passes the session\'s previously collected data into the prompt', async () => {
    mockedGenerateStructured.mockResolvedValueOnce({
      fields: [{ name: 'email' }],
      suggestedValues: [],
    });

    const sessionId = 'route-test-session-2';
    getOrCreateSession(sessionId);
    recordValidatedStep(sessionId, 'priorStep', { employmentStatus: 'employed' });

    await request(createApp()).post('/api/step/fields').send({ sessionId, endpoint });

    const [prompt] = mockedGenerateStructured.mock.calls[0];
    expect(prompt).toContain('employmentStatus');
    expect(prompt).toContain('employed');
  });

  it('returns 400 when the request body is invalid', async () => {
    const response = await request(createApp())
      .post('/api/step/fields')
      .send({ sessionId: 'x' }); // missing endpoint

    expect(response.status).toBe(400);
    expect(mockedGenerateStructured).not.toHaveBeenCalled();
  });

  it('returns 500 with the error message when something genuinely unexpected breaks', async () => {
    // selectStepFields degrades gracefully on its own and structurally never
    // throws -- this simulates the "something genuinely unexpected broke"
    // case the route's catch block exists for, proving that safety net
    // itself works even though it's never expected to trigger normally.
    mockedSelectStepFields.mockRejectedValueOnce(new Error('unexpected failure'));

    const response = await request(createApp())
      .post('/api/step/fields')
      .send({ sessionId: 'route-test-session-500', endpoint });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('unexpected failure');
  });
});

describe('scoped context', () => {
  it('only passes the data of precedingEndpointIds to the step engine', async () => {
    const sessionId = 'scoped-fields-session';
    getOrCreateSession(sessionId);
    recordValidatedStep(sessionId, 'stepA', { a: 1 });
    recordValidatedStep(sessionId, 'stepC', { c: 3 }); // a later step, visited before going back
    mockedGenerateStructured.mockResolvedValueOnce({ fields: [{ name: 'email' }], suggestedValues: [] });

    await request(createApp())
      .post('/api/step/fields')
      .send({ sessionId, endpoint, precedingEndpointIds: ['stepA'] });

    expect(mockedSelectStepFields).toHaveBeenLastCalledWith({ endpoint, previouslyCollectedData: { stepA: { a: 1 } } });
  });

  it('keeps passing all collected data when precedingEndpointIds is absent (v1.0 clients)', async () => {
    const sessionId = 'unscoped-fields-session';
    getOrCreateSession(sessionId);
    recordValidatedStep(sessionId, 'stepA', { a: 1 });
    mockedGenerateStructured.mockResolvedValueOnce({ fields: [{ name: 'email' }], suggestedValues: [] });

    await request(createApp()).post('/api/step/fields').send({ sessionId, endpoint });

    expect(mockedSelectStepFields).toHaveBeenLastCalledWith({ endpoint, previouslyCollectedData: { stepA: { a: 1 } } });
  });
});
