import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../llmClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../llmClient.js')>()),
  generateStructured: vi.fn(),
}));

import { generateStructured } from '../llmClient.js';
import { createApp } from '../app.js';
import { getOrCreateSession, recordValidatedStep } from '../sessionStore.js';

const mockedGenerateStructured = vi.mocked(generateStructured);
const account = { id: 'account', title: 'Account', fields: [] };
const payout = { id: 'payout', title: 'Payout', fields: [{ name: 'bank', type: 'string', label: 'Bank', required: true }] };

beforeEach(() => {
  mockedGenerateStructured.mockReset();
});

describe('POST /api/step/classify-failure', () => {
  it('classifies using the failed step data from the session', async () => {
    getOrCreateSession('cf-session');
    recordValidatedStep('cf-session', 'payout', { bank: 'Hold Bank' });
    mockedGenerateStructured.mockResolvedValueOnce({
      classification: 'fundamental',
      explanation: 'On hold.',
      rollbackFromEndpointId: 'account',
    });

    const response = await request(createApp())
      .post('/api/step/classify-failure')
      .send({
        sessionId: 'cf-session',
        failedEndpoint: payout,
        failure: { kind: 'http', status: 403, message: 'account on compliance hold' },
        completedEndpoints: [account],
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ classification: 'fundamental', explanation: 'On hold.', rollbackFromEndpointId: 'account', degraded: false });
    expect(String(mockedGenerateStructured.mock.calls[0][0])).toContain('Hold Bank');
  });

  it('rejects an unknown failure kind', async () => {
    const response = await request(createApp())
      .post('/api/step/classify-failure')
      .send({ sessionId: 's', failedEndpoint: payout, failure: { kind: 'boom' }, completedEndpoints: [] });
    expect(response.status).toBe(400);
  });
});
