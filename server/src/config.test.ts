import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { configJsonSchema, loadConfig } from './config.js';

function dirWith(files: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentintake-config-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

const valid = {
  $schema: './schemas/agentintake.config.schema.json',
  guidance: {
    domainContext: 'Onboarding for sellers who want to receive payouts.',
    tone: 'Friendly, concise, second person.',
    outputLanguage: 'es-MX',
    extraRules: { validate: ['Accept P.O. boxes as valid addresses.'] },
  },
};

describe('loadConfig', () => {
  it('loads agentintake.config.json from the working directory', () => {
    expect(loadConfig({}, dirWith({ 'agentintake.config.json': valid }))).toEqual(valid);
  });

  it('a missing default file means no guidance', () => {
    expect(loadConfig({}, dirWith({}))).toBeNull();
  });

  it('AGENTINTAKE_CONFIG points somewhere else, relative to the working directory', () => {
    const dir = dirWith({ 'other.json': { guidance: { tone: 'Formal.' } }, 'agentintake.config.json': valid });
    expect(loadConfig({ AGENTINTAKE_CONFIG: 'other.json' }, dir)).toEqual({ guidance: { tone: 'Formal.' } });
  });

  it('a missing AGENTINTAKE_CONFIG file is an error, not "no guidance"', () => {
    expect(() => loadConfig({ AGENTINTAKE_CONFIG: 'nope.json' }, dirWith({}))).toThrow(/AGENTINTAKE_CONFIG: .*nope\.json does not exist/);
  });

  it('names the file, the place and the rule for an invalid value', () => {
    const dir = dirWith({ 'agentintake.config.json': { guidance: { tone: 'x'.repeat(201), outputLanguage: 'not a language' } } });
    const load = () => loadConfig({}, dir);
    expect(load).toThrow(path.join(dir, 'agentintake.config.json'));
    expect(load).toThrow(/guidance\.tone: Too big: expected string to have <=200 characters/);
    expect(load).toThrow(/guidance\.outputLanguage: Must be a BCP-47 language tag/);
  });

  it('rejects unknown keys, so a misspelled slot is not silently ignored', () => {
    const dir = dirWith({ 'agentintake.config.json': { guidance: { extraRules: { validation: ['x'] } } } });
    expect(() => loadConfig({}, dir)).toThrow(/guidance\.extraRules: Unrecognized key: "validation"/);
  });

  it('limits extra rules to 10 per call, 300 characters each', () => {
    const tooMany = dirWith({ 'agentintake.config.json': { guidance: { extraRules: { validate: Array(11).fill('r') } } } });
    expect(() => loadConfig({}, tooMany)).toThrow(/guidance\.extraRules\.validate: Too big/);
    const tooLong = dirWith({ 'agentintake.config.json': { guidance: { extraRules: { validate: ['r'.repeat(301)] } } } });
    expect(() => loadConfig({}, tooLong)).toThrow(/guidance\.extraRules\.validate\.0: Too big/);
  });

  it('reports a file that is not JSON', () => {
    expect(() => loadConfig({}, dirWith({ 'agentintake.config.json': '{ guidance: ' }))).toThrow(/not valid JSON/);
  });
});

describe('published JSON Schema', () => {
  const file = fileURLToPath(new URL('../../schemas/agentintake.config.schema.json', import.meta.url));
  const expected = JSON.stringify(configJsonSchema(), null, 2) + '\n';

  it('matches the runtime schema (regenerate with UPDATE_SCHEMAS=1 npx vitest run server/src/config.test.ts)', () => {
    if (process.env.UPDATE_SCHEMAS) writeFileSync(file, expected);
    expect(readFileSync(file, 'utf-8')).toBe(expected);
  });
});
