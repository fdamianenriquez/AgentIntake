import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { FlowGenerationResult } from '../flowGenerator.js';

vi.mock('../llmClient.js', () => ({
  generateStructured: vi.fn(),
}));

import { generateStructured } from '../llmClient.js';
import { createApp } from '../app.js';

const mockedGenerateStructured = vi.mocked(generateStructured);

const fixtureSpec = fileURLToPath(new URL('../__fixtures__/ref-example.openapi.yaml', import.meta.url));

const generatedResult: FlowGenerationResult = {
  flow: {
    id: 'createWidgetFlow',
    title: 'Widget Creation',
    description: 'Create a new widget.',
    endpoints: [
      {
        id: 'createWidget',
        title: 'Create Widget',
        fields: [
          { name: 'name', type: 'string', label: 'Name', required: true },
          { name: 'quantity', type: 'number', label: 'Quantity', required: false, validation: { min: 1 } },
        ],
        auth: { type: 'none' },
      },
    ],
  },
  ambiguousFields: [],
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'agent-intake-route-test-'));
  mockedGenerateStructured.mockReset();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('POST /api/generate-flow', () => {
  it('parses a real spec fixture, generates a flow (LLM mocked), and returns it', async () => {
    mockedGenerateStructured.mockResolvedValueOnce(generatedResult);

    const response = await request(createApp()).post('/api/generate-flow').send({ spec: fixtureSpec });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(generatedResult);
  });

  it('returns 400 when the body is missing "spec"', async () => {
    const response = await request(createApp()).post('/api/generate-flow').send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/spec/);
    expect(mockedGenerateStructured).not.toHaveBeenCalled();
  });

  it('returns 400 when the spec has no write operations', async () => {
    const noWriteSpecPath = path.join(tmpDir, 'no-writes.openapi.json');
    await writeFile(
      noWriteSpecPath,
      JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Read-only Fixture API', version: '1.0.0' },
        paths: { '/widgets': { get: { responses: { '200': { description: 'OK' } } } } },
      })
    );

    const response = await request(createApp()).post('/api/generate-flow').send({ spec: noWriteSpecPath });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/No write operations/);
  });

  it('returns 500 when the spec cannot be found', async () => {
    const response = await request(createApp())
      .post('/api/generate-flow')
      .send({ spec: './definitely-does-not-exist.yaml' });

    expect(response.status).toBe(500);
    expect(response.body.error).toBeDefined();
  });
});
