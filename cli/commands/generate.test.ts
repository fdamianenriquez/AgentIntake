import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUIDANCE_LIMITS, type FlowGenerationResult } from '../../packages/react-agent-intake/src/contracts.js';

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

  it('applies the guidance in agentintake.config.json (AGENTINTAKE_CONFIG) to generation', async () => {
    const configPath = path.join(outputDir, 'agentintake.config.json');
    await writeFile(configPath, JSON.stringify({ guidance: { outputLanguage: 'ja', extraRules: { generation: ['Keep titles short.'] } } }));
    process.env.AGENTINTAKE_CONFIG = configPath;
    mockedGenerateStructured.mockResolvedValueOnce(generatedResult);

    try {
      await runGenerate({ spec: fixtureSpec, output: outputPath });
    } finally {
      delete process.env.AGENTINTAKE_CONFIG;
    }

    const [prompt] = mockedGenerateStructured.mock.calls[0];
    expect(prompt).toContain('Write all user-facing text in: ja');
    expect(prompt).toContain('- Keep titles short.');
  });

  it('refuses to run with an invalid config, before calling the model', async () => {
    const configPath = path.join(outputDir, 'agentintake.config.json');
    await writeFile(configPath, JSON.stringify({ guidance: { outputLanguage: 'not a language' } }));
    process.env.AGENTINTAKE_CONFIG = configPath;

    try {
      await expect(runGenerate({ spec: fixtureSpec, output: outputPath })).rejects.toThrow(/guidance\.outputLanguage/);
    } finally {
      delete process.env.AGENTINTAKE_CONFIG;
    }
    expect(mockedGenerateStructured).not.toHaveBeenCalled();
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

describe('regenerating over a flow.json with author guidance', () => {
  const existing = {
    ...generatedResult.flow,
    guidance: 'Most buyers are schools.',
    outputLanguage: 'es-MX',
    endpoints: [
      { ...generatedResult.flow.endpoints[0], guidance: 'Quantities are whole boxes.' },
      { id: 'removedStep', title: 'Removed', fields: [], guidance: 'This step is gone from the spec.' },
    ],
  };
  const writeExisting = (content: unknown) => writeFile(outputPath, JSON.stringify(content, null, 2) + '\n');

  it('refuses to overwrite it without --keep-guidance or --force, before calling the model', async () => {
    await writeExisting(existing);

    await expect(runGenerate({ spec: fixtureSpec, output: outputPath })).rejects.toThrow(/--keep-guidance.*--force/s);

    expect(mockedGenerateStructured).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toEqual(existing);
  });

  it('overwrites a flow.json without guidance, as before', async () => {
    await writeExisting(generatedResult.flow);
    mockedGenerateStructured.mockResolvedValueOnce(generatedResult);

    await runGenerate({ spec: fixtureSpec, output: outputPath });

    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toEqual(generatedResult.flow);
  });

  it('--force overwrites it, guidance and all', async () => {
    await writeExisting(existing);
    mockedGenerateStructured.mockResolvedValueOnce(generatedResult);

    await runGenerate({ spec: fixtureSpec, output: outputPath, force: true });

    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toEqual(generatedResult.flow);
  });

  it('--keep-guidance carries the guidance over by endpoint id and reports what was dropped', async () => {
    await writeExisting(existing);
    mockedGenerateStructured.mockResolvedValueOnce(generatedResult);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runGenerate({ spec: fixtureSpec, output: outputPath, keepGuidance: true });

    const written = JSON.parse(await readFile(outputPath, 'utf-8'));
    expect(written.guidance).toBe('Most buyers are schools.');
    expect(written.outputLanguage).toBe('es-MX');
    expect(written.endpoints[0].guidance).toBe('Quantities are whole boxes.');
    expect(written.endpoints.map((e: { id: string }) => e.id)).toEqual(['createWidget']);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/removedStep/);
    warn.mockRestore();
  });

  it('--keep-guidance checks the kept guidance before parsing the spec or calling the model', async () => {
    await writeExisting({
      ...existing,
      endpoints: [{ ...existing.endpoints[0], guidance: 'x'.repeat(GUIDANCE_LIMITS.endpointGuidance + 1) }],
    });

    const run = runGenerate({ spec: fixtureSpec, output: outputPath, keepGuidance: true });

    await expect(run).rejects.toThrow(outputPath);
    await expect(run).rejects.toThrow(/endpoints\[createWidget\]\.guidance: Too big: expected string to have <=500 characters/);
    expect(mockedGenerateStructured).not.toHaveBeenCalled();
  });

  it('--keep-guidance rejects a kept language tag that is not valid', async () => {
    await writeExisting({ ...existing, outputLanguage: 'not a language' });

    await expect(runGenerate({ spec: fixtureSpec, output: outputPath, keepGuidance: true })).rejects.toThrow(
      /outputLanguage: Must be a BCP-47 language tag/
    );
    expect(mockedGenerateStructured).not.toHaveBeenCalled();
  });

  it('refuses --keep-guidance together with --force', async () => {
    await expect(runGenerate({ spec: fixtureSpec, output: outputPath, keepGuidance: true, force: true })).rejects.toThrow(
      /either --keep-guidance or --force/
    );
  });
});
