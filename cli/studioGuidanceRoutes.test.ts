import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/src/llmClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/src/llmClient.js')>()),
  buildModel: vi.fn(() => ({})),
  generateStructured: vi.fn(),
}));

import { generateStructured } from '../server/src/llmClient.js';
import { createApp } from '../server/src/app.js';
import { localOnlyGuard } from './localOnlyGuard.js';
import { createStudioConfigStore } from './studioConfig.js';
import { registerStudioGuidanceRoutes } from './studioGuidanceRoutes.js';

const mocked = vi.mocked(generateStructured);

const field = (name: string) => ({ name, type: 'string', label: name, required: true });
const flow = {
  id: 'onboarding',
  title: 'Onboarding',
  description: 'd',
  guidance: 'Small sellers.',
  outputLanguage: 'es-MX',
  endpoints: [
    { id: 'account', title: 'Account', fields: [field('name')] },
    { id: 'payout', title: 'Payout', fields: [field('bank'), field('holder')], guidance: 'Holder must match.' },
  ],
};

let dir: string;

// Studio as `studio` wires it: the guard first, then the shared routes reading
// the config store, then the Studio-only routes.
function studio(files: Record<string, unknown> = {}, casesDir?: string) {
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), JSON.stringify(content));
  const configStore = createStudioConfigStore({}, dir);
  const app = express();
  app.use(localOnlyGuard());
  app.use(createApp({ warnOpenCors: false, getConfig: configStore.get, trustedFlows: null }));
  registerStudioGuidanceRoutes(app, { configStore, casesDir });
  return { app, configStore };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'agentintake-studio-routes-'));
  vi.stubEnv('LLM_PROVIDER', 'openrouter');
  vi.stubEnv('LLM_MODEL', 'some/model');
  vi.stubEnv('AGENTINTAKE_STATIC_MODE', '');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocked.mockReset();
  mocked.mockRejectedValue(new Error('no model in this test'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('every Studio guidance route is local-only', () => {
  it.each([
    ['get', '/api/studio/config'],
    ['post', '/api/studio/config'],
    ['post', '/api/studio/render-prompt'],
    ['get', '/api/studio/evals/plan'],
    ['post', '/api/studio/evals'],
    ['get', '/api/studio/evals/some-id'],
    ['delete', '/api/studio/evals/some-id'],
  ] as const)('%s %s rejects a non-loopback Host and a cross-site Origin', async (method, route) => {
    const { app } = studio();
    const foreignHost = await request(app)[method](route).set('Host', 'attacker.example:4000');
    const crossSite = await request(app)[method](route).set('Host', 'localhost:4000').set('Origin', 'https://attacker.example');
    expect(foreignHost.status).toBe(403);
    expect(crossSite.status).toBe(403);
  });
});

describe('config', () => {
  it('GET returns the current guidance, the resolved path and the limits', async () => {
    const { app } = studio({ 'agentintake.config.json': { guidance: { tone: 'Formal.' } } });
    const response = await request(app).get('/api/studio/config');

    expect(response.body).toEqual({
      guidance: { tone: 'Formal.' },
      path: path.join(dir, 'agentintake.config.json'),
      limits: expect.objectContaining({ domainContext: 1000, tone: 200, extraRules: 10, extraRule: 300 }),
    });
  });

  it('POST validates with the config schema and names the field', async () => {
    const { app } = studio();
    const response = await request(app)
      .post('/api/studio/config')
      .send({ guidance: { tone: 'x'.repeat(201), outputLanguage: 'not a language' } });

    expect(response.status).toBe(400);
    expect(response.body.issues.map((issue: { path: string }) => issue.path).sort()).toEqual(['guidance.outputLanguage', 'guidance.tone']);
    expect(existsSync(path.join(dir, 'agentintake.config.json'))).toBe(false);
  });

  it('POST never takes a path from the request', async () => {
    const { app } = studio();
    const elsewhere = path.join(dir, 'elsewhere.json');
    const response = await request(app).post('/api/studio/config').send({ guidance: { tone: 'Formal.' }, path: elsewhere });

    expect(response.status).toBe(400);
    expect(existsSync(elsewhere)).toBe(false);
  });

  it('POST writes the resolved file, keeps $schema, drops empty fields, and swaps the config Studio uses', async () => {
    const { app, configStore } = studio({ 'agentintake.config.json': { $schema: './schemas/x.json', guidance: { tone: 'Old.' } } });
    const response = await request(app)
      .post('/api/studio/config')
      .send({ guidance: { tone: 'New tone.', outputLanguage: '', extraRules: { validate: ['Rule one.', ''] } } });

    const saved = { $schema: './schemas/x.json', guidance: { tone: 'New tone.', extraRules: { validate: ['Rule one.'] } } };
    expect(response.status).toBe(200);
    expect(response.body.config).toEqual(saved);
    expect(JSON.parse(readFileSync(path.join(dir, 'agentintake.config.json'), 'utf-8'))).toEqual(saved);
    expect(configStore.get()).toEqual(saved);

    // The very next runtime call uses it.
    await request(app).post('/api/step/validate').send({ sessionId: 's', endpoint: flow.endpoints[1], data: { bank: 'B' } });
    expect(mocked.mock.calls[0][0]).toContain('Tone: New tone.');
    expect(mocked.mock.calls[0][0]).toContain('- Rule one.');
  });

  it('a failed write leaves no partial or temporary file, and keeps the old config', async () => {
    // The target is a directory, so the final rename fails.
    mkdirSync(path.join(dir, 'target'));
    writeFileSync(path.join(dir, 'target', 'keep.txt'), 'x');
    const configStore = { path: path.join(dir, 'target'), get: vi.fn(() => null), set: vi.fn() };
    const app = express();
    registerStudioGuidanceRoutes(app, { configStore });

    const response = await request(app).post('/api/studio/config').send({ guidance: { tone: 'Formal.' } });

    expect(response.status).toBe(500);
    expect(readdirSync(dir).sort()).toEqual(['target']);
    expect(configStore.set).not.toHaveBeenCalled();
  });
});

describe('render-prompt', () => {
  it('returns exactly the prompt the runtime call would send, with the guidance block marked', async () => {
    const { app } = studio({ 'agentintake.config.json': { guidance: { tone: 'Formal.' } } });
    const data = { bank: 'B', holder: 'H' };

    const rendered = await request(app).post('/api/studio/render-prompt').send({ call: 'validate', flow, endpointId: 'payout', data });
    await request(app)
      .post('/api/step/validate')
      .send({ sessionId: 'fresh', flow: { id: flow.id, guidance: flow.guidance, outputLanguage: flow.outputLanguage }, endpoint: flow.endpoints[1], data });

    const runtimePrompt = mocked.mock.calls[0][0];
    expect(rendered.body.prompt).toBe(runtimePrompt);
    const { start, end } = rendered.body.guidanceRange;
    const block = rendered.body.prompt.slice(start, end);
    expect(block.startsWith('Guidance from the author of this form.')).toBe(true);
    expect(block).toContain('Guidance for the step "Payout": Holder must match.');
    expect(block.trimEnd().endsWith('AUTHOR_GUIDANCE>>>')).toBe(true);
  });

  it.each(['generation', 'selectFields', 'invalidation', 'classifyFailure'])('renders %s with the same narrowing', async (call) => {
    const { app } = studio();
    const response = await request(app).post('/api/studio/render-prompt').send({ call, flow, endpointId: 'account' });

    expect(response.status).toBe(200);
    if (call === 'generation') expect(response.body.guidanceRange).toBeNull(); // no global config: no guidance at all
    else expect(response.body.prompt).toContain('About this form: Small sellers.');
  });

  it('guidanceRange is null without guidance', async () => {
    const { app } = studio();
    const plain = { ...flow, guidance: undefined, outputLanguage: undefined, endpoints: flow.endpoints.map(({ guidance: _g, ...e }) => e) };
    const response = await request(app).post('/api/studio/render-prompt').send({ call: 'validate', flow: plain, endpointId: 'payout' });

    expect(response.body.guidanceRange).toBeNull();
    expect(response.body.prompt).not.toContain('AUTHOR_GUIDANCE');
  });

  it('rejects an unknown step or call', async () => {
    const { app } = studio();
    expect((await request(app).post('/api/studio/render-prompt').send({ call: 'validate', flow, endpointId: 'nope' })).status).toBe(400);
    expect((await request(app).post('/api/studio/render-prompt').send({ call: 'chat', flow })).status).toBe(400);
  });
});

describe('evals', () => {
  const endpoint = { id: 'payout', title: 'Payout', fields: [field('bank')] };
  function casesDir(count: number): string {
    const root = mkdtempSync(path.join(tmpdir(), 'agentintake-studio-cases-'));
    mkdirSync(path.join(root, 'validate'));
    for (let i = 0; i < count; i++) {
      writeFileSync(
        path.join(root, 'validate', `c${i}.json`),
        JSON.stringify({ call: 'validate', name: `case ${i}`, input: { endpoint, data: { bank: 'B' } }, expect: { valid: true } })
      );
    }
    return root;
  }
  // Each model call waits until the test lets it through.
  function heldModel() {
    const waiting: Array<() => void> = [];
    mocked.mockImplementation(async () => {
      await new Promise<void>((resolve) => waiting.push(resolve));
      return { valid: true, errors: [] } as never;
    });
    return waiting;
  }

  it('the plan says how many runs, with which provider and model', async () => {
    const { app } = studio({}, casesDir(3));
    const response = await request(app).get('/api/studio/evals/plan?calls=validate&repeat=2');

    expect(response.body).toEqual({ runs: 6, provider: 'openrouter', model: 'some/model' });
    expect(mocked).not.toHaveBeenCalled();
  });

  it('runs one job at a time, reports progress, and ends with the report', async () => {
    const waiting = heldModel();
    const { app } = studio({}, casesDir(2));

    const started = await request(app).post('/api/studio/evals').send({ calls: ['validate'] });
    expect(started.status).toBe(202);
    expect(started.body).toEqual({ jobId: expect.any(String), runs: 2 });
    const job = `/api/studio/evals/${started.body.jobId}`;

    expect((await request(app).post('/api/studio/evals').send({})).status).toBe(409);

    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    waiting[0]();
    await vi.waitFor(async () => expect((await request(app).get(job)).body).toMatchObject({ status: 'running', done: 1, total: 2 }));
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    waiting[1]();

    await vi.waitFor(async () => expect((await request(app).get(job)).body.status).toBe('done'));
    const done = (await request(app).get(job)).body;
    expect(done).toMatchObject({ done: 2, total: 2, report: { totals: { runs: 2, passed: 2 } } });
    expect(done).not.toHaveProperty('controller');
  });

  it('cancel stops new runs; the one in flight finishes', async () => {
    const waiting = heldModel();
    const { app } = studio({}, casesDir(3));
    const { jobId } = (await request(app).post('/api/studio/evals').send({})).body;

    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    await request(app).delete(`/api/studio/evals/${jobId}`);
    waiting[0]();

    await vi.waitFor(async () => expect((await request(app).get(`/api/studio/evals/${jobId}`)).body.status).toBe('cancelled'));
    const cancelled = (await request(app).get(`/api/studio/evals/${jobId}`)).body;
    expect(cancelled).toMatchObject({ done: 1, total: 3, report: { totals: { runs: 1 } } });
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it('uses the current config and the flow sent with the request', async () => {
    heldModel();
    const { app } = studio({ 'agentintake.config.json': { guidance: { tone: 'Formal.' } } }, casesDir(1));
    await request(app)
      .post('/api/studio/evals')
      .send({ flow: { id: 'f', title: 't', description: 'd', endpoints: [{ ...endpoint, guidance: 'Bank guidance.' }] } });

    await vi.waitFor(() => expect(mocked).toHaveBeenCalled());
    expect(mocked.mock.calls[0][0]).toContain('Tone: Formal.');
    expect(mocked.mock.calls[0][0]).toContain('Guidance for the step "Payout": Bank guidance.');
  });

  it('refuses to start in static mode, or with invalid options', async () => {
    const { app } = studio({}, casesDir(1));
    expect((await request(app).post('/api/studio/evals').send({ calls: ['chat'] })).status).toBe(400);
    vi.stubEnv('AGENTINTAKE_STATIC_MODE', '1');
    const response = await request(app).post('/api/studio/evals').send({});
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/AGENTINTAKE_STATIC_MODE/);
    expect(mocked).not.toHaveBeenCalled();
  });

  it('unknown jobs are 404', async () => {
    const { app } = studio({}, casesDir(1));
    expect((await request(app).get('/api/studio/evals/nope')).status).toBe(404);
    expect((await request(app).delete('/api/studio/evals/nope')).status).toBe(404);
  });
});
