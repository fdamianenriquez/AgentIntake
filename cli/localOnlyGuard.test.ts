import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { localOnlyGuard } from './localOnlyGuard.js';

function makeApp() {
  const app = express();
  app.use(localOnlyGuard());
  app.post('/api/provider-setup', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('localOnlyGuard', () => {
  it.each(['localhost:4000', '127.0.0.1:4000', '[::1]:4000', 'localhost'])('allows Host %s', async (host) => {
    const response = await request(makeApp()).post('/api/provider-setup').set('Host', host);
    expect(response.status).toBe(200);
  });

  it('rejects a non-loopback Host (DNS rebinding)', async () => {
    const response = await request(makeApp()).post('/api/provider-setup').set('Host', 'attacker.example:4000');
    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/localhost/);
  });

  it('allows a same-origin browser request', async () => {
    const response = await request(makeApp())
      .post('/api/provider-setup')
      .set('Host', 'localhost:4000')
      .set('Origin', 'http://localhost:4000');
    expect(response.status).toBe(200);
  });

  it.each(['https://attacker.example', 'http://localhost:3000', 'null'])(
    'rejects a cross-origin request from %s',
    async (origin) => {
      const response = await request(makeApp())
        .post('/api/provider-setup')
        .set('Host', 'localhost:4000')
        .set('Origin', origin);
      expect(response.status).toBe(403);
      expect(response.body.error).toMatch(/Cross-origin/);
    }
  );

  it('also rejects the CORS preflight from another origin', async () => {
    const response = await request(makeApp())
      .options('/api/provider-setup')
      .set('Host', 'localhost:4000')
      .set('Origin', 'https://attacker.example');
    expect(response.status).toBe(403);
  });
});
