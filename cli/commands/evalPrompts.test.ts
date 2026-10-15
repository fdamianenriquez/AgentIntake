import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../server/src/llmClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/src/llmClient.js')>()),
  buildModel: vi.fn(() => ({})),
  generateStructured: vi.fn(),
}));

import { generateStructured } from '../../server/src/llmClient.js';
import { builtinCasesDir, EXIT_BELOW_MIN_PASS, EXIT_OK, EXIT_USAGE, runEvalPrompts, type EvalPromptsIO } from './evalPrompts.js';

const mocked = vi.mocked(generateStructured);

const endpoint = { id: 'payout', title: 'Payout', fields: [{ name: 'bank', type: 'string', label: 'Bank', required: true }] };
const passing = { call: 'validate', name: 'passes', input: { endpoint, data: { bank: 'B' } }, expect: { valid: true } };
const failing = { call: 'validate', name: 'fails', input: { endpoint, data: { bank: 'B' } }, expect: { valid: false } };

function casesDir(cases: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentintake-eval-cli-'));
  for (const [name, content] of Object.entries(cases)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

function io(overrides: Partial<EvalPromptsIO> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const ask = vi.fn(async () => 'y');
  return {
    io: { isTTY: true, ask, out: (t: string) => out.push(t), err: (t: string) => err.push(t), ...overrides } as EvalPromptsIO,
    out,
    err,
    ask,
  };
}

beforeEach(() => {
  vi.stubEnv('LLM_PROVIDER', 'openrouter');
  vi.stubEnv('LLM_MODEL', 'some/model');
  vi.stubEnv('AGENTINTAKE_STATIC_MODE', '');
  vi.stubEnv('AGENTINTAKE_CONFIG', '');
  mocked.mockReset();
  mocked.mockResolvedValue({ valid: true, errors: [] } as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const own = (cases: Record<string, unknown>) => ({ cases: casesDir(cases), builtin: false });

describe('confirmation', () => {
  it('says how many runs and which model, and runs on "y"', async () => {
    const t = io();
    const code = await runEvalPrompts({ ...own({ 'validate/a.json': passing }), repeat: '3' }, t.io);

    expect(t.ask).toHaveBeenCalledWith(expect.stringMatching(/run 3 eval case run\(s\).*openrouter \/ some\/model.*Continue\? \[y\/N\]/));
    expect(mocked).toHaveBeenCalledTimes(3);
    expect(code).toBe(EXIT_OK);
  });

  it('makes no model calls when the answer is anything but yes', async () => {
    const t = io({ ask: vi.fn(async () => '') });
    const code = await runEvalPrompts(own({ 'validate/a.json': passing }), t.io);

    expect(mocked).not.toHaveBeenCalled();
    expect(t.err.join('\n')).toMatch(/Cancelled/);
    expect(code).toBe(EXIT_OK);
  });

  it('--yes skips the question', async () => {
    const t = io();
    await runEvalPrompts({ ...own({ 'validate/a.json': passing }), yes: true }, t.io);

    expect(t.ask).not.toHaveBeenCalled();
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it('without a terminal and without --yes, refuses instead of waiting', async () => {
    const t = io({ isTTY: false });
    const code = await runEvalPrompts(own({ 'validate/a.json': passing }), t.io);

    expect(code).toBe(EXIT_USAGE);
    expect(t.ask).not.toHaveBeenCalled();
    expect(mocked).not.toHaveBeenCalled();
    expect(t.err.join('\n')).toMatch(/Pass --yes/);
  });

  it('counts the built-in suite too', async () => {
    const ask = vi.fn(async (_question: string) => 'n');
    await runEvalPrompts({}, io({ ask }).io);

    const count = Number(/run (\d+) eval case run/.exec(ask.mock.calls[0][0])![1]);
    expect(count).toBeGreaterThanOrEqual(27);
    expect(mocked).not.toHaveBeenCalled();
  });
});

describe('output and exit codes', () => {
  it('--json prints only the report, as JSON', async () => {
    const t = io();
    await runEvalPrompts({ ...own({ 'validate/a.json': passing }), json: true, yes: true }, t.io);

    expect(t.out).toHaveLength(1);
    const report = JSON.parse(t.out[0]);
    expect(report).toMatchObject({ provider: 'openrouter', model: 'some/model', totals: { runs: 1, passed: 1 } });
    expect(t.err).toEqual([]);
  });

  it('prints a table per call and the failing runs', async () => {
    const t = io();
    await runEvalPrompts({ ...own({ 'validate/a.json': passing, 'validate/b.json': failing }), yes: true, minPass: '0.4' }, t.io);

    const text = t.out.join('\n');
    expect(text).toMatch(/validate\s+2\s+1\s+50%/);
    expect(text).toMatch(/Failing runs:\n {2}validate > fails \(run 1, guidance none\): valid was true, expected false/);
  });

  it('exits 1 when a call passes less than --min-pass, 0 otherwise', async () => {
    const cases = own({ 'validate/a.json': passing, 'validate/b.json': failing });
    expect(await runEvalPrompts({ ...cases, yes: true, minPass: '0.9' }, io().io)).toBe(EXIT_BELOW_MIN_PASS);
    expect(await runEvalPrompts({ ...cases, yes: true, minPass: '0.5' }, io().io)).toBe(EXIT_OK);
  });

  it('defaults --min-pass to 0.9', async () => {
    expect(await runEvalPrompts({ ...own({ 'validate/a.json': passing, 'validate/b.json': failing }), yes: true }, io().io)).toBe(
      EXIT_BELOW_MIN_PASS
    );
  });
});

describe('usage and configuration errors: exit 2, no model calls', () => {
  const dir = () => own({ 'validate/a.json': passing });

  it.each([
    ['an invalid case file', () => own({ 'validate/a.json': { ...passing, extra: 1 } }), /Unrecognized key: "extra"/],
    [
      'an invalid config',
      () => {
        const d = dir();
        const config = path.join(d.cases, '..', `bad-config-${Math.random()}.json`);
        writeFileSync(config, JSON.stringify({ guidance: { tone: 'x'.repeat(201) } }));
        return { ...d, config };
      },
      /guidance\.tone/,
    ],
    [
      'an invalid flow',
      () => {
        const d = dir();
        const flow = path.join(d.cases, '..', `bad-flow-${Math.random()}.json`);
        writeFileSync(flow, JSON.stringify({ id: 'f', title: 't', description: 'd', endpoints: [], outputLanguage: '???' }));
        return { ...d, flow };
      },
      /outputLanguage/,
    ],
    ['an unknown call', () => ({ ...dir(), calls: 'validate,validation' }), /--calls takes/],
    ['a bad repeat', () => ({ ...dir(), repeat: '0' }), /--repeat must be/],
    ['a bad min-pass', () => ({ ...dir(), minPass: '90' }), /--min-pass must be/],
    ['a bad concurrency', () => ({ ...dir(), concurrency: '8' }), /--concurrency must be/],
    ['no cases at all', () => ({ builtin: false }), /No eval cases/],
  ])('%s', async (_label, options, message) => {
    const t = io();
    const code = await runEvalPrompts({ ...options(), yes: true }, t.io);

    expect(code).toBe(EXIT_USAGE);
    expect(t.err.join('\n')).toMatch(message);
    expect(mocked).not.toHaveBeenCalled();
  });

  it('an invalid AGENTINTAKE_LOG_LEVEL is refused', async () => {
    vi.stubEnv('AGENTINTAKE_LOG_LEVEL', 'verbose');
    const t = io();

    expect(await runEvalPrompts({ ...dir(), yes: true }, t.io)).toBe(EXIT_USAGE);
    expect(t.err.join('\n')).toMatch(/AGENTINTAKE_LOG_LEVEL must be one of/);
    expect(mocked).not.toHaveBeenCalled();
  });

  it('static mode is refused', async () => {
    vi.stubEnv('AGENTINTAKE_STATIC_MODE', '1');
    const t = io();

    expect(await runEvalPrompts({ ...dir(), yes: true }, t.io)).toBe(EXIT_USAGE);
    expect(t.err.join('\n')).toMatch(/AGENTINTAKE_STATIC_MODE is on/);
    expect(mocked).not.toHaveBeenCalled();
  });

  it('a missing API key is reported before any case runs', async () => {
    const { buildModel } = await import('../../server/src/llmClient.js');
    vi.mocked(buildModel).mockImplementationOnce(() => {
      throw new Error('LLM_API_KEY is not set.');
    });
    const t = io();

    expect(await runEvalPrompts({ ...dir(), yes: true }, t.io)).toBe(EXIT_USAGE);
    expect(t.err.join('\n')).toMatch(/LLM_API_KEY/);
  });
});

describe('builtinCasesDir', () => {
  it('finds evals/cases from the source tree', () => {
    expect(builtinCasesDir()).toMatch(/evals[/\\]cases$/);
  });
});
