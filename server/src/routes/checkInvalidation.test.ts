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

const account = { id: 'account', title: 'Account', fields: [{ name: 'type', type: 'string', label: 'Type', required: true }] };
const payout = { id: 'payout', title: 'Payout', fields: [{ name: 'holder', type: 'string', label: 'Holder', required: true }] };

beforeEach(() => {
  mockedGenerateStructured.mockReset();
});

describe('POST /api/step/check-invalidation', () => {
  it('returns the affected later steps, using what the session holds for them', async () => {
    getOrCreateSession('inv-session');
    recordValidatedStep('inv-session', 'payout', { holder: 'Jordan Rivera' });
    mockedGenerateStructured.mockResolvedValueOnce({ affected: [{ endpointId: 'payout', reason: 'Name must match.' }] });

    const response = await request(createApp())
      .post('/api/step/check-invalidation')
      .send({
        sessionId: 'inv-session',
        editedEndpoint: account,
        before: { type: 'individual' },
        after: { type: 'business' },
        laterCompletedEndpoints: [payout],
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ affected: [{ endpointId: 'payout', reason: 'Name must match.' }], degraded: false });
    expect(String(mockedGenerateStructured.mock.calls[0][0])).toContain('Jordan Rivera');
  });

  it('rejects a body that only sends ids instead of endpoint definitions', async () => {
    const response = await request(createApp())
      .post('/api/step/check-invalidation')
      .send({ sessionId: 's', editedEndpoint: 'account', before: {}, after: {}, laterCompletedEndpoints: ['payout'] });

    expect(response.status).toBe(400);
  });
});
