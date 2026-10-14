import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTrustedFlows } from './trustedFlows.js';

const flow = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: 'T',
  description: 'd',
  endpoints: [{ id: 'step', title: 'Step', fields: [] }],
  ...extra,
});

function dirWith(files: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentintake-flows-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

describe('loadTrustedFlows', () => {
  it('is off when AGENTINTAKE_FLOWS_DIR is unset', () => {
    expect(loadTrustedFlows({}, dirWith({}))).toBeNull();
  });

  it('loads every .json file, keyed by flow id, and ignores other files', () => {
    const dir = dirWith({ 'a.json': flow('onboarding', { guidance: 'g' }), 'b.json': flow('payouts'), 'notes.txt': 'x' });
    const flows = loadTrustedFlows({ AGENTINTAKE_FLOWS_DIR: dir }, '/');
    expect([...flows!.keys()]).toEqual(['onboarding', 'payouts']);
    expect(flows!.get('onboarding')!.guidance).toBe('g');
  });

  it('resolves the directory relative to the working directory', () => {
    const dir = dirWith({ 'a.json': flow('onboarding') });
    expect(loadTrustedFlows({ AGENTINTAKE_FLOWS_DIR: path.basename(dir) }, path.dirname(dir))!.has('onboarding')).toBe(true);
  });

  it('fails on a missing directory, an invalid flow, or a repeated id, naming the file', () => {
    expect(() => loadTrustedFlows({ AGENTINTAKE_FLOWS_DIR: '/no/such/dir' }, '/')).toThrow(/is not a directory/);

    const invalid = dirWith({ 'bad.json': flow('x', { outputLanguage: 'not a language' }) });
    expect(() => loadTrustedFlows({ AGENTINTAKE_FLOWS_DIR: invalid }, '/')).toThrow(/bad\.json is not a valid flow:\n {2}outputLanguage/);

    const repeated = dirWith({ 'a.json': flow('same'), 'b.json': flow('same') });
    expect(() => loadTrustedFlows({ AGENTINTAKE_FLOWS_DIR: repeated }, '/')).toThrow(/b\.json: flow id "same" is also used by .*a\.json/);

    const notJson = dirWith({ 'a.json': '{' });
    expect(() => loadTrustedFlows({ AGENTINTAKE_FLOWS_DIR: notJson }, '/')).toThrow(/a\.json: not valid JSON/);
  });
});
