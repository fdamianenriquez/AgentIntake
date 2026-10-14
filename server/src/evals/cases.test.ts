import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCases } from './cases.js';

const endpoint = { id: 'createPayout', title: 'Payout', fields: [{ name: 'bank', type: 'string', label: 'Bank', required: true }] };
const validateCase = {
  call: 'validate',
  name: 'a plausible submission is valid',
  input: { endpoint, data: { bank: 'First Example Bank' } },
  expect: { valid: true },
};

function casesDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentintake-cases-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

describe('loadCases', () => {
  it('loads one case per file, from a directory per call', () => {
    const dir = casesDir({
      'validate/plausible.json': validateCase,
      'classifyFailure/hold.json': {
        call: 'classifyFailure',
        name: 'a compliance hold is fundamental',
        input: { failedEndpoint: endpoint, failure: { kind: 'http', status: 403, message: 'hold' }, completedEndpoints: [] },
        expect: { classification: 'fundamental', rollbackFromEndpointId: null },
        repeat: 3,
        notes: 'n',
      },
    });

    const cases = loadCases(dir);

    expect(cases.map((c) => [c.call, c.name])).toEqual([
      ['classifyFailure', 'a compliance hold is fundamental'],
      ['validate', 'a plausible submission is valid'],
    ]);
    expect(cases[0]).toMatchObject({ repeat: 3, notes: 'n', file: path.join(dir, 'classifyFailure/hold.json') });
  });

  it('resolves fixtures relative to the case file and validates them', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agentintake-cases-'));
    const write = (name: string, content: unknown) => {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      writeFileSync(path.join(root, name), JSON.stringify(content));
    };
    write('fixtures/config.json', { guidance: { tone: 'Formal.' } });
    write('fixtures/flow.json', { id: 'f', title: 't', description: 'd', endpoints: [endpoint] });
    write('cases/validate/guided.json', { ...validateCase, fixtures: { config: '../../fixtures/config.json', flow: '../../fixtures/flow.json' } });

    const [loaded] = loadCases(path.join(root, 'cases'));

    expect(loaded.fixtures!.config).toEqual({ guidance: { tone: 'Formal.' } });
    expect(loaded.fixtures!.flow!.id).toBe('f');
  });

  it.each([
    ['an unknown key', { 'validate/a.json': { ...validateCase, extra: 1 } }, /a\.json is not a valid validate case:\n {2}\(top level\): Unrecognized key: "extra"/],
    ['an unknown key inside expect', { 'validate/a.json': { ...validateCase, expect: { valid: true, mode: 'x' } } }, /expect: Unrecognized key: "mode"/],
    ['a call that does not match its directory', { 'selectFields/a.json': validateCase }, /"call" is "validate", but the file is in the "selectFields" directory/],
    ['an unknown call directory', { 'validation/a.json': validateCase }, /unknown call "validation"/],
    ['a file that is not JSON', { 'validate/a.json': '{' }, /a\.json: not valid JSON/],
    ['a non-JSON file', { 'validate/a.txt': 'x' }, /a\.txt: case files must be \.json/],
    ['an invalid input', { 'validate/a.json': { ...validateCase, input: { data: {} } } }, /input\.endpoint/],
    ['an empty include/exclude expectation', { 'selectFields/a.json': { call: 'selectFields', name: 'n', input: { endpoint }, expect: {} } }, /Give mustInclude, mustExclude or both/],
    ['a missing fixture', { 'validate/a.json': { ...validateCase, fixtures: { config: 'nope.json' } } }, /nope\.json/],
  ])('fails with the path and the problem for %s', (_label, files, message) => {
    const dir = casesDir(files);
    expect(() => loadCases(dir)).toThrow(message);
  });
});
