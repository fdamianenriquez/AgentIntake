import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { getOrCreateSession, getSession, recordValidatedStep } from '../sessionStore.js';

describe('POST /api/session/sync', () => {
  it('replaces a step\'s data and forgets steps sent as null', async () => {
    const sessionId = 'sync-session';
    getOrCreateSession(sessionId);
    recordValidatedStep(sessionId, 'stepA', { name: 'edited, then cancelled' });
    recordValidatedStep(sessionId, 'stepB', { b: 1 });

    const response = await request(createApp())
      .post('/api/session/sync')
      .send({
        sessionId,
        steps: [
          { endpointId: 'stepA', data: { name: 'original' } },
          { endpointId: 'stepB', data: null },
        ],
      });

    expect(response.status).toBe(200);
    expect(getSession(sessionId)?.collectedData).toEqual({ stepA: { name: 'original' } });
    expect(getSession(sessionId)?.validatedEndpointIds).toEqual(['stepA']);
  });

  it('rejects a malformed body', async () => {
    const response = await request(createApp()).post('/api/session/sync').send({ sessionId: 's', steps: [] });
    expect(response.status).toBe(400);
  });
});
