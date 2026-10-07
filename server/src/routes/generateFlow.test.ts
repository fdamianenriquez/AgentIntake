import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { FlowGenerationResult } from '../../../packages/react-agent-intake/src/contracts.js';

vi.mock('../llmClient.js', () => ({
  generateStructured: vi.fn(),
}));

import { generateStructured } from '../llmClient.js';
import { createApp } from '../app.js';

const mockedGenerateStructured = vi.mocked(generateStructured);

const fixtureSpecPath = fileURLToPath(new URL('../__fixtures__/ref-example.openapi.yaml', import.meta.url));

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

beforeEach(() => {
  mockedGenerateStructured.mockReset();
});

describe('POST /api/generate-flow', () => {
  it('parses real spec content (LLM mocked) and returns the generated flow', async () => {
    mockedGenerateStructured.mockResolvedValueOnce(generatedResult);
    const specContent = await readFile(fixtureSpecPath, 'utf-8');

    const response = await request(createApp()).post('/api/generate-flow').send({ specContent });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ...generatedResult, warnings: [] });
  });

  it('includes a warnings entry when the spec has more write operations than v1 is tuned for', async () => {
    const endpointCount = 16;
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < endpointCount; i++) {
      paths[`/widgets${i}`] = {
        post: { operationId: `createWidget${i}`, responses: { '201': { description: 'Created' } } },
      };
    }
    const specContent = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Large Fixture API', version: '1.0.0' },
      paths,
    });

    mockedGenerateStructured.mockResolvedValueOnce({
      flow: {
        id: 'large-flow',
        title: 'Large Flow',
        description: 'Many endpoints.',
        endpoints: Array.from({ length: endpointCount }, (_, i) => ({
          id: `createWidget${i}`,
          title: `Create Widget ${i}`,
          fields: [],
          auth: { type: 'none' as const },
        })),
      },
      ambiguousFields: [],
    });

    const response = await request(createApp()).post('/api/generate-flow').send({ specContent });

    expect(response.status).toBe(200);
    expect(response.body.warnings).toHaveLength(1);
    expect(response.body.warnings[0]).toMatch(/16 write operations/);
  });

  it('returns 400 when the body is missing "specContent"', async () => {
    const response = await request(createApp()).post('/api/generate-flow').send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/specContent/);
    expect(mockedGenerateStructured).not.toHaveBeenCalled();
  });

  it('returns 400 when a path/URL is sent instead of spec content (the old, now-removed contract)', async () => {
    const response = await request(createApp())
      .post('/api/generate-flow')
      .send({ spec: fixtureSpecPath });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/specContent/);
  });

  it('returns 400 when the spec has no write operations', async () => {
    const specContent = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Read-only Fixture API', version: '1.0.0' },
      paths: { '/widgets': { get: { responses: { '200': { description: 'OK' } } } } },
    });

    const response = await request(createApp()).post('/api/generate-flow').send({ specContent });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/No write operations/);
  });

  it('returns 500 when specContent is neither valid JSON nor YAML', async () => {
    const response = await request(createApp())
      .post('/api/generate-flow')
      .send({ specContent: '{{{ not json or yaml : : :' });

    expect(response.status).toBe(500);
    expect(response.body.error).toBeDefined();
  });

  it('returns the parser warnings (e.g. an update outside any resource family) alongside the flow', async () => {
    mockedGenerateStructured.mockResolvedValueOnce({
      flow: {
        id: 'settings',
        title: 'Settings',
        description: 'Update settings.',
        endpoints: [{ id: 'updateSettings', title: 'Settings', fields: [{ name: 'theme' }] }],
      },
      ambiguousFields: [],
    });
    const specContent = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Settings', version: '1' },
      paths: {
        '/me/settings': {
          put: {
            operationId: 'updateSettings',
            requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { theme: { type: 'string' } } } } } },
            responses: {},
          },
        },
      },
    });

    const response = await request(createApp()).post('/api/generate-flow').send({ specContent });

    expect(response.status).toBe(200);
    expect(response.body.warnings).toEqual([expect.stringContaining('PUT /me/settings')]);
  });
});
