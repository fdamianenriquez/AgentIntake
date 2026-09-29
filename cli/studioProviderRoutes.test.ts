import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStudioProviderRoutes } from './studioProviderRoutes.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  registerStudioProviderRoutes(app);
  return app;
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'agent-intake-studio-test-'));
  vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  delete process.env.LLM_PROVIDER;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('GET /api/provider-status', () => {
  it('reports not configured when nothing is set', async () => {
    const response = await request(makeApp()).get('/api/provider-status');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ configured: false });
  });

  it('reports configured when the resolved provider has its key set', async () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'test-key';

    const response = await request(makeApp()).get('/api/provider-status');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ configured: true, provider: 'openrouter' });
  });

  it('reports not configured (not an error) when LLM_PROVIDER is unrecognized', async () => {
    process.env.LLM_PROVIDER = 'not-a-real-provider';

    const response = await request(makeApp()).get('/api/provider-status');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ configured: false });
  });
});

describe('POST /api/provider-setup', () => {
  it('creates .env when none exists, and applies the config to the running process', async () => {
    const response = await request(makeApp())
      .post('/api/provider-setup')
      .send({ provider: 'anthropic', apiKey: 'sk-test-123' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });

    const written = await readFile(path.join(tmpDir, '.env'), 'utf-8');
    expect(written).toContain('LLM_PROVIDER=anthropic');
    expect(written).toContain('ANTHROPIC_API_KEY=sk-test-123');

    expect(process.env.LLM_PROVIDER).toBe('anthropic');
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-test-123');
  });

  it('updates an existing .env in place without disturbing unrelated lines', async () => {
    await writeFile(
      path.join(tmpDir, '.env'),
      'LLM_PROVIDER=openai\nOPENAI_API_KEY=old-key\nSOME_OTHER_VAR=keep-me\n',
      'utf-8'
    );

    const response = await request(makeApp())
      .post('/api/provider-setup')
      .send({ provider: 'openai', apiKey: 'new-key' });

    expect(response.status).toBe(200);

    const written = await readFile(path.join(tmpDir, '.env'), 'utf-8');
    const lines = written.trim().split('\n');
    expect(lines).toContain('LLM_PROVIDER=openai');
    expect(lines).toContain('OPENAI_API_KEY=new-key');
    expect(lines).toContain('SOME_OTHER_VAR=keep-me');
    expect(lines.filter((line) => line.startsWith('OPENAI_API_KEY='))).toHaveLength(1);
  });

  it('returns 400 for an invalid body', async () => {
    const response = await request(makeApp()).post('/api/provider-setup').send({ provider: 'anthropic' }); // missing apiKey

    expect(response.status).toBe(400);
  });

  it('returns 400 for an unrecognized provider', async () => {
    const response = await request(makeApp())
      .post('/api/provider-setup')
      .send({ provider: 'not-a-real-provider', apiKey: 'x' });

    expect(response.status).toBe(400);
  });
});
