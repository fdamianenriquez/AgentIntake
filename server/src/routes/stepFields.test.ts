import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { ParsedEndpoint } from '../flowSchema.js';

vi.mock('../llmClient.js', () => ({
  generateStructured: vi.fn(),
}));

import { generateStructured } from '../llmClient.js';
import { createApp } from '../app.js';
import { getOrCreateSession, getSession, recordValidatedStep } from '../sessionStore.js';

const mockedGenerateStructured = vi.mocked(generateStructured);

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
      suggestedValues: {},
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
      suggestedValues: {},
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
});
