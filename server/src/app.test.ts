import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';

function specOfSize(bytes: number): string {
  return `openapi: 3.0.3\ninfo: {title: Big, version: "1"}\npaths: {}\n# ${'x'.repeat(bytes)}`;
}

describe('createApp body limits and error responses', () => {
  it('accepts a multi-megabyte spec on /api/generate-flow', async () => {
    const response = await request(createApp())
      .post('/api/generate-flow')
      .send({ specContent: specOfSize(3 * 1024 * 1024) });

    // Parsed fine; rejected only because the fixture has no write operations.
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/No write operations/);
  });

  it('rejects a spec over the limit with a JSON 413, not an HTML error page', async () => {
    const response = await request(createApp())
      .post('/api/generate-flow')
      .send({ specContent: specOfSize(11 * 1024 * 1024) });

    expect(response.status).toBe(413);
    expect(response.type).toBe('application/json');
    expect(response.body).toEqual({ error: 'Request body is too large (limit: 10 MB).' });
  });

  it('keeps the small default limit on the per-step routes', async () => {
    const response = await request(createApp())
      .post('/api/step/validate')
      .send({ sessionId: 's', data: { blob: 'x'.repeat(200 * 1024) } });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: 'Request body is too large (limit: 100 KB).' });
  });

  it('answers malformed JSON with a JSON 400 and no stack trace', async () => {
    const response = await request(createApp()).post('/api/step/fields').set('Content-Type', 'application/json').send('{"sessionId": ');

    expect(response.status).toBe(400);
    expect(response.type).toBe('application/json');
    expect(response.body).toEqual({ error: 'Request body is not valid JSON.' });
  });
});

describe('CORS', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // A fresh module per test: the "CORS is open" warning is once per process.
  async function freshCreateApp() {
    return (await import('./app.js')).createApp;
  }

  it('with AGENTINTAKE_CORS_ORIGINS set, only those origins get the CORS header', async () => {
    vi.stubEnv('AGENTINTAKE_CORS_ORIGINS', 'https://app.example.com, https://admin.example.com');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = (await freshCreateApp())();

    const allowed = await request(app).post('/api/session/sync').set('Origin', 'https://admin.example.com').send({});
    const other = await request(app).post('/api/session/sync').set('Origin', 'https://elsewhere.example').send({});

    expect(allowed.headers['access-control-allow-origin']).toBe('https://admin.example.com');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("an entry with a trailing slash still matches the browser's Origin", async () => {
    vi.stubEnv('AGENTINTAKE_CORS_ORIGINS', 'https://app.example.com/');
    const app = (await freshCreateApp())();

    const response = await request(app).post('/api/session/sync').set('Origin', 'https://app.example.com').send({});

    expect(response.headers['access-control-allow-origin']).toBe('https://app.example.com');
  });

  it.each(['https://app.example.com/app', 'app.example.com', 'ftp://files.example.com', 'https://app.example.com?x=1'])(
    'refuses to start with an entry that is not an origin (%s), naming it',
    async (entry) => {
      vi.stubEnv('AGENTINTAKE_CORS_ORIGINS', `https://ok.example.com, ${entry}`);
      const create = await freshCreateApp();

      expect(() => create()).toThrow(entry);
    }
  );

  it('unset: any origin is allowed, as before, and a warning is logged once', async () => {
    vi.stubEnv('AGENTINTAKE_CORS_ORIGINS', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const create = await freshCreateApp();

    const response = await request(create()).post('/api/session/sync').set('Origin', 'https://elsewhere.example').send({});
    create();

    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/AGENTINTAKE_CORS_ORIGINS/);
    expect(warn.mock.calls[0][0]).toMatch(/localhost or an internal network.*model calls/);
  });

  it('Studio can skip the warning (its own guard already rejects other origins)', async () => {
    vi.stubEnv('AGENTINTAKE_CORS_ORIGINS', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    (await freshCreateApp())({ warnOpenCors: false });

    expect(warn).not.toHaveBeenCalled();
  });
});
