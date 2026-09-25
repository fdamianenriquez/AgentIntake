import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { ParsedEndpoint } from '../flowSchema.js';

vi.mock('../llmClient.js', () => ({
  generateStructured: vi.fn(),
}));

import { generateStructured } from '../llmClient.js';
import { createApp } from '../app.js';
import { getSession } from '../sessionStore.js';

const mockedGenerateStructured = vi.mocked(generateStructured);

const endpoint: ParsedEndpoint = {
  id: 'createCandidate',
  title: 'Your Details',
  fields: [{ name: 'email', type: 'string', label: 'Email', required: true }],
  auth: { type: 'none' },
};

beforeEach(() => {
  mockedGenerateStructured.mockReset();
});

describe('POST /api/step/validate', () => {
  it('returns valid:true and records the step in the session when the semantic check passes', async () => {
    mockedGenerateStructured.mockResolvedValueOnce({ valid: true, errors: [] });

    const sessionId = 'route-validate-session-1';
    const data = { email: 'a@b.com' };
    const response = await request(createApp())
      .post('/api/step/validate')
      .send({ sessionId, endpoint, data });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ valid: true, errors: {}, degraded: false });
    expect(getSession(sessionId)?.collectedData.createCandidate).toEqual(data);
    expect(getSession(sessionId)?.completedEndpointIds).toEqual(['createCandidate']);
  });

  it('returns valid:false with inline errors and does not record the step', async () => {
    mockedGenerateStructured.mockResolvedValueOnce({
      valid: false,
      errors: [{ name: 'email', message: 'Looks fake.' }],
    });

    const sessionId = 'route-validate-session-2';
    const response = await request(createApp())
      .post('/api/step/validate')
      .send({ sessionId, endpoint, data: { email: 'nope' } });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ valid: false, errors: { email: 'Looks fake.' }, degraded: false });
    expect(getSession(sessionId)?.completedEndpointIds).toEqual([]);
  });

  it('returns 400 when the request body is invalid', async () => {
    const response = await request(createApp())
      .post('/api/step/validate')
      .send({ sessionId: 'x', endpoint }); // missing data

    expect(response.status).toBe(400);
    expect(mockedGenerateStructured).not.toHaveBeenCalled();
  });
});
