import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowGenerationResult } from '../../packages/react-agent-intake/src/contracts.js';

vi.mock('../../server/src/llmClient.js', () => ({
  resolveProvider: vi.fn(() => 'anthropic'),
  buildModel: vi.fn(() => ({})),
  generateStructured: vi.fn(),
}));

import { generateStructured } from '../../server/src/llmClient.js';
import { runGenerate } from './generate.js';

const mockedGenerateStructured = vi.mocked(generateStructured);

const fixtureSpec = fileURLToPath(
  new URL('../../server/src/__fixtures__/ref-example.openapi.yaml', import.meta.url)
);

const generatedResult: FlowGenerationResult = {
  flow: {
    id: 'createWidgetFlow',
    title: 'Widget Creation',
    description: 'Create a new widget.',
    endpoints: [
      {
        id: 'createWidget',
        title: 'Create Widget',
        description: 'Enter widget details.',
        fields: [
          { name: 'name', type: 'string', label: 'Name', required: true },
          {
            name: 'quantity',
            type: 'number',
            label: 'Quantity',
            required: false,
            validation: { min: 1 },
          },
        ],
        auth: { type: 'none' },
      },
    ],
  },
  ambiguousFields: [
    { endpointId: 'createWidget', fieldName: 'quantity', note: 'Purpose unclear from the spec.' },
  ],
};

let outputDir: string;
let outputPath: string;

beforeEach(async () => {
  outputDir = await mkdtemp(path.join(tmpdir(), 'agent-intake-cli-test-'));
  outputPath = path.join(outputDir, 'flow.json');
  mockedGenerateStructured.mockReset();
});

afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
  delete process.env.LLM_PROVIDER;
  delete process.env.LLM_MODEL;
});

describe('runGenerate', () => {
  it('parses a real spec fixture, generates a flow (LLM mocked), and writes valid flow.json', async () => {
    mockedGenerateStructured.mockResolvedValueOnce(generatedResult);

    await runGenerate({ spec: fixtureSpec, output: outputPath });

    const written = JSON.parse(await readFile(outputPath, 'utf-8'));
    expect(written).toEqual(generatedResult.flow);
  });

  it('passes the mechanically-parsed endpoints (from the real spec) into flow generation', async () => {
    mockedGenerateStructured.mockResolvedValueOnce(generatedResult);

    await runGenerate({ spec: fixtureSpec, output: outputPath });

    const [prompt] = mockedGenerateStructured.mock.calls[0];
    expect(prompt).toContain('createWidget');
    expect(prompt).toContain('"name": "name"');
  });

  it('sets LLM_PROVIDER/LLM_MODEL from --provider/--model flags before generating', async () => {
    mockedGenerateStructured.mockResolvedValueOnce(generatedResult);

    await runGenerate({ spec: fixtureSpec, output: outputPath, provider: 'openrouter', model: 'openrouter/free' });

    expect(process.env.LLM_PROVIDER).toBe('openrouter');
    expect(process.env.LLM_MODEL).toBe('openrouter/free');
  });

  it('rejects with a clear error and writes nothing when the spec file does not exist', async () => {
    await expect(runGenerate({ spec: './nope-does-not-exist.yaml', output: outputPath })).rejects.toThrow();
    await expect(readFile(outputPath, 'utf-8')).rejects.toThrow(/ENOENT/);
  });

  it('throws a clear error when the spec has no write operations at all', async () => {
    const noWriteSpecPath = path.join(outputDir, 'no-writes.openapi.json');
    await writeFile(
      noWriteSpecPath,
      JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Read-only Fixture API', version: '1.0.0' },
        paths: {
          '/widgets': { get: { responses: { '200': { description: 'OK' } } } },
        },
      })
    );

    await expect(runGenerate({ spec: noWriteSpecPath, output: outputPath })).rejects.toThrow(
      /No write operations/
    );
    expect(mockedGenerateStructured).not.toHaveBeenCalled();
  });

  it('warns (but still generates) when the spec has more write operations than v1 is tuned for', async () => {
    const endpointCount = 16;
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < endpointCount; i++) {
      paths[`/widgets${i}`] = {
        post: {
          operationId: `createWidget${i}`,
          responses: { '201': { description: 'Created' } },
        },
      };
    }
    const largeSpecPath = path.join(outputDir, 'large.openapi.json');
    await writeFile(
      largeSpecPath,
      JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Large Fixture API', version: '1.0.0' },
        paths,
      })
    );

    const largeResult: FlowGenerationResult = {
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
    };
    mockedGenerateStructured.mockResolvedValueOnce(largeResult);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runGenerate({ spec: largeSpecPath, output: outputPath });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/16 write operations/));

    const written = JSON.parse(await readFile(outputPath, 'utf-8'));
    expect(written.endpoints).toHaveLength(endpointCount);

    warnSpy.mockRestore();
  });
});

describe('runGenerate with resource families', () => {
  const familySpec = `openapi: 3.0.3
info: { title: Payments, version: "1" }
paths:
  /accounts:
    post:
      operationId: createAccount
      requestBody: { content: { application/json: { schema: { type: object, properties: { email: { type: string } } } } } }
      responses: {}
  /accounts/{accountId}:
    parameters: [{ name: accountId, in: path, required: true, schema: { type: string } }]
    get: { responses: {} }
    delete: { responses: {} }
  /accounts/{accountId}/payout-methods:
    post:
      operationId: createPayoutMethod
      parameters:
        - { name: accountId, in: path, required: true, schema: { type: string } }
        - { name: Idempotency-Key, in: header, required: true, schema: { type: string } }
      requestBody: { content: { application/json: { schema: { type: object, properties: { bank: { type: string } } } } } }
      responses: {}
`;

  it('writes the parser metadata into flow.json and tells the author what each endpoint needs', async () => {
    const specPath = path.join(outputDir, 'payments.yaml');
    await writeFile(specPath, familySpec, 'utf-8');
    mockedGenerateStructured.mockResolvedValueOnce({
      flow: {
        id: 'payments',
        title: 'Payments',
        description: 'Set up payments.',
        endpoints: [
          { id: 'createAccount', title: 'Account', fields: [{ name: 'email' }] },
          { id: 'createPayoutMethod', title: 'Payout', fields: [{ name: 'bank' }] },
        ],
      },
      ambiguousFields: [],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runGenerate({ spec: specPath, output: outputPath });

    const written = JSON.parse(await readFile(outputPath, 'utf-8'));
    expect(written.endpoints[0]).toMatchObject({
      id: 'createAccount',
      resourcePath: '/accounts',
      idParam: 'accountId',
      capabilities: { read: true, update: false, undo: true },
    });
    expect(written.endpoints[1]).toMatchObject({ id: 'createPayoutMethod', pathParams: ['accountId'] });
    expect(written.endpoints[1].fields.map((f: { name: string }) => f.name)).toEqual(['bank']);

    const logged = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('createAccount: the API also offers read, undo on /accounts/{accountId}');
    expect(logged).toContain('createPayoutMethod: fill path parameter(s) accountId from ctx.results');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('requires the header "Idempotency-Key"'));

    log.mockRestore();
    warn.mockRestore();
  });
});
