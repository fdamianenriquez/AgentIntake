import request from 'supertest';
import { describe, expect, it } from 'vitest';
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
    const response = await request(createApp())
      .post('/api/step/fields')
      .set('Content-Type', 'application/json')
      .send('{"sessionId": ');

    expect(response.status).toBe(400);
    expect(response.type).toBe('application/json');
    expect(response.body).toEqual({ error: 'Request body is not valid JSON.' });
  });
});
