import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../llmClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../llmClient.js')>()),
  generateStructured: vi.fn(),
}));

import { generateStructured } from '../llmClient.js';
import { createApp } from '../app.js';
import type { AgentIntakeConfig } from '../config.js';

const mocked = vi.mocked(generateStructured);

const endpoint = {
  id: 'createPayout',
  title: 'Payout',
  fields: [{ name: 'bank', type: 'string', label: 'Bank', required: true }],
};
const config: AgentIntakeConfig = {
  guidance: {
    domainContext: 'Payouts for sellers.',
    outputLanguage: 'es-MX',
    extraRules: { validate: ['Accept P.O. boxes.'], classifyFailure: ['A hold is fundamental.'] },
  },
};

// Every route's model call, with the prompt it sends. The call itself fails,
// so each route takes its degraded path; only the prompt matters here.
const calls = [
  { route: '/api/step/fields', body: { sessionId: 's1', endpoint }, rule: undefined },
  { route: '/api/step/validate', body: { sessionId: 's1', endpoint, data: { bank: 'B' } }, rule: 'Accept P.O. boxes.' },
  {
    route: '/api/step/check-invalidation',
    body: { sessionId: 's1', editedEndpoint: endpoint, before: {}, after: { bank: 'C' }, laterCompletedEndpoints: [{ ...endpoint, id: 'later' }] },
    rule: undefined,
  },
  {
    route: '/api/step/classify-failure',
    body: { sessionId: 's1', failedEndpoint: endpoint, failure: { kind: 'http', status: 403 }, completedEndpoints: [] },
    rule: 'A hold is fundamental.',
  },
];

beforeEach(() => {
  mocked.mockReset();
  mocked.mockRejectedValue(new Error('no model in this test'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('global guidance reaches every runtime call', () => {
  it.each(calls)('$route: the config\'s guidance, with only this call\'s rules', async ({ route, body, rule }) => {
    await request(createApp({ config })).post(route).send(body);

    const prompt = mocked.mock.calls[0][0];
    expect(prompt).toContain('Business context: Payouts for sellers.');
    expect(prompt).toContain('Write all user-facing text in: es-MX');
    for (const other of ['Accept P.O. boxes.', 'A hold is fundamental.']) {
      if (other === rule) expect(prompt).toContain(`- ${other}`);
      else expect(prompt).not.toContain(other);
    }
  });

  it.each(calls)('$route: no config, no guidance block', async ({ route, body }) => {
    await request(createApp({ config: null })).post(route).send(body);

    expect(mocked.mock.calls[0][0]).not.toContain('AUTHOR_GUIDANCE');
  });

  it('flow generation gets the global guidance too', async () => {
    const spec = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'T', version: '1' },
      paths: { '/things': { post: { operationId: 'createThing', responses: { '201': { description: 'ok' } } } } },
    });
    await request(createApp({ config })).post('/api/generate-flow').send({ specContent: spec });

    expect(mocked.mock.calls[0][0]).toContain('Business context: Payouts for sellers.');
  });
});

describe('loading the config file', () => {
  it('createApp loads AGENTINTAKE_CONFIG, and an invalid file stops it with the file and the problem', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agentintake-app-config-'));
    const file = path.join(dir, 'bad.json');
    writeFileSync(file, JSON.stringify({ guidance: { tone: 'x'.repeat(201) } }));
    vi.stubEnv('AGENTINTAKE_CONFIG', file);

    expect(() => createApp()).toThrow(file);
    expect(() => createApp()).toThrow(/guidance\.tone/);
  });
});
