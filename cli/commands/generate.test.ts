import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowGenerationResult } from '../../server/src/flowGenerator.js';

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
});
