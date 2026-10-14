import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../llmClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../llmClient.js')>()),
  generateStructured: vi.fn(),
}));

import type { ParsedEndpoint } from '../../../packages/react-agent-intake/src/contracts.js';
import { generateStructured } from '../llmClient.js';
import type { EvalCase } from './cases.js';
import { countRuns, runEvals } from './runEvals.js';

const mocked = vi.mocked(generateStructured);

const field = (name: string) => ({ name, type: 'string' as const, label: name, required: false });
const verification: ParsedEndpoint = { id: 'verify', title: 'Verify', fields: ['dob', 'idNumber', 'legalName'].map(field) };
const payout: ParsedEndpoint = { id: 'payout', title: 'Payout', fields: ['bank', 'holder'].map(field) };
const account: ParsedEndpoint = { id: 'account', title: 'Account', fields: ['name', 'type'].map(field) };

// What the model "answers" for each call in these tests.
let answers: {
  fields: string[];
  valid: boolean;
  errors: string[];
  affected: string[];
  classification: string;
  anchor: string | null;
  ambiguous: string[];
};

function reply(prompt: string): unknown {
  if (prompt.startsWith('You are choosing')) {
    return { fields: answers.fields.map((name) => ({ name, descriptionOverride: null })), suggestedValues: [] };
  }
  if (prompt.startsWith('You are validating')) {
    return { valid: answers.valid, errors: answers.errors.map((name) => ({ name, message: 'no' })) };
  }
  if (prompt.startsWith('In a multi-step intake wizard')) {
    return { affected: answers.affected.map((endpointId) => ({ endpointId, reason: 'r' })) };
  }
  if (prompt.startsWith('A multi-step intake wizard')) {
    return { classification: answers.classification, explanation: 'e', rollbackFromEndpointId: answers.anchor };
  }
  return {
    flow: {
      id: 'f',
      title: 'F',
      description: 'd',
      endpoints: [{ id: 'payout', title: 'Payout', description: null, fields: payout.fields.map(({ name }) => ({ name, labelOverride: null, descriptionOverride: null })) }],
    },
    ambiguousFields: answers.ambiguous.map((fieldName) => ({ endpointId: 'payout', fieldName, note: 'n' })),
  };
}

const kase = <C extends EvalCase['call']>(call: C, input: unknown, expectation: unknown, extra: Partial<EvalCase> = {}): EvalCase =>
  ({ file: `/cases/${call}/${extra.name ?? 'case'}.json`, call, name: extra.name ?? 'case', input, expect: expectation, ...extra }) as EvalCase;

beforeEach(() => {
  answers = { fields: ['dob', 'idNumber'], valid: true, errors: [], affected: ['payout'], classification: 'fundamental', anchor: 'account', ambiguous: ['holder'] };
  mocked.mockReset();
  mocked.mockImplementation(async (prompt) => reply(prompt) as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function outcome(c: EvalCase) {
  const report = await runEvals({ cases: [c] });
  const summary = report.calls[c.call]!;
  return { passed: summary.passed === 1, failure: summary.failures[0] };
}

describe('expectations, one call at a time', () => {
  it('selectFields: mustInclude / mustExclude', async () => {
    const input = { endpoint: verification };
    expect((await outcome(kase('selectFields', input, { mustInclude: ['dob'], mustExclude: ['legalName'] }))).passed).toBe(true);
    const failed = await outcome(kase('selectFields', input, { mustInclude: ['legalName'], mustExclude: ['dob'] }));
    expect(failed.passed).toBe(false);
    expect(failed.failure).toMatchObject({ reason: 'missing legalName; unexpected dob', got: { fields: ['dob', 'idNumber'] } });
  });

  it('validate: valid, and error fields exact or as a subset', async () => {
    const input = { endpoint: payout, data: { bank: 'B', holder: 'H' } };
    answers.valid = false;
    answers.errors = ['holder', 'bank'];
    expect((await outcome(kase('validate', input, { valid: false, errorFields: { fields: ['holder'], mode: 'subset' } }))).passed).toBe(true);
    expect((await outcome(kase('validate', input, { valid: false, errorFields: { fields: ['holder'], mode: 'exact' } }))).failure?.reason).toBe(
      'error fields were [holder, bank], expected exact [holder]'
    );
    expect((await outcome(kase('validate', input, { valid: true }))).failure?.reason).toBe('valid was false, expected true');
  });

  it('invalidation: an exact set, or include/exclude', async () => {
    const input = { editedEndpoint: account, before: {}, after: { name: 'x' }, laterCompletedEndpoints: [verification, payout] };
    expect((await outcome(kase('invalidation', input, { affected: ['payout'] }))).passed).toBe(true);
    expect((await outcome(kase('invalidation', input, { affected: [] }))).failure?.reason).toBe('affected [payout], expected exactly []');
    expect((await outcome(kase('invalidation', input, { mustExclude: ['payout'] }))).passed).toBe(false);
  });

  it('classifyFailure: the classification and, when given, the anchor', async () => {
    const input = { failedEndpoint: payout, failure: { kind: 'http', status: 403 }, completedEndpoints: [account] };
    expect((await outcome(kase('classifyFailure', input, { classification: 'fundamental', rollbackFromEndpointId: 'account' }))).passed).toBe(true);
    expect((await outcome(kase('classifyFailure', input, { classification: 'fundamental' }))).passed).toBe(true);
    expect((await outcome(kase('classifyFailure', input, { classification: 'fundamental', rollbackFromEndpointId: null }))).failure?.reason).toBe(
      'rollbackFromEndpointId was account, expected null'
    );
    expect((await outcome(kase('classifyFailure', input, { classification: 'retryable' }))).failure?.reason).toBe(
      'classification was fundamental, expected retryable'
    );
  });

  it('generation: every endpoint present, and ambiguous fields to include or exclude', async () => {
    const input = { endpoints: [payout] };
    expect((await outcome(kase('generation', input, {}))).passed).toBe(true);
    expect((await outcome(kase('generation', input, { ambiguousFields: { mustInclude: ['holder'] } }))).passed).toBe(true);
    expect((await outcome(kase('generation', input, { ambiguousFields: { mustExclude: ['holder'] } }))).failure?.reason).toBe(
      'unexpected holder'
    );
  });
});

describe('degraded runs', () => {
  it('count as failures, separately, with the reason the engine gave', async () => {
    mocked.mockRejectedValue(new Error('The model did not respond within 15 seconds.'));
    const report = await runEvals({ cases: [kase('selectFields', { endpoint: verification }, { mustInclude: ['dob'] })] });

    expect(report.calls.selectFields).toMatchObject({ runs: 1, passed: 0, failed: 1, degraded: 1, passRate: 0 });
    expect(report.calls.selectFields!.failures[0]).toMatchObject({
      degraded: true,
      degradedReason: 'The model did not respond within 15 seconds.',
    });
  });

  it('a generation that fails is degraded too, with its error', async () => {
    mocked.mockRejectedValue(new Error('provider said no'));
    const report = await runEvals({ cases: [kase('generation', { endpoints: [payout] }, {})] });

    expect(report.calls.generation!.failures[0]).toMatchObject({ degraded: true, degradedReason: expect.stringContaining('provider said no') });
  });

  it('does not print the engine\'s own degradation warnings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocked.mockRejectedValue(new Error('x'));
    await runEvals({ cases: [kase('validate', { endpoint: payout, data: {} }, { valid: true })] });

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('overlapping runs', () => {
  it('each keeps its own fallback reasons, and console.warn is left untouched', async () => {
    const originalWarn = console.warn;
    const releases: Array<() => void> = [];
    mocked.mockImplementation(async (prompt) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      throw new Error(prompt.includes('"A"') ? 'reason A' : 'reason B');
    });
    const caseFor = (title: string) =>
      kase('selectFields', { endpoint: { ...verification, title } }, { mustInclude: ['dob'] }, { name: title });

    const first = runEvals({ cases: [caseFor('A')] });
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const second = runEvals({ cases: [caseFor('B')] });
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[0](); // the first ends while the second is still running
    const firstReport = await first;
    releases[1]();
    const secondReport = await second;

    expect(firstReport.calls.selectFields!.failures[0].degradedReason).toBe('reason A');
    expect(secondReport.calls.selectFields!.failures[0].degradedReason).toBe('reason B');
    expect(console.warn).toBe(originalWarn);
  });
});

describe('repeat and concurrency', () => {
  const c = kase('selectFields', { endpoint: verification }, { mustInclude: ['dob'] }, { repeat: 3 });

  it('runs a case its own repeat times, unless the run sets repeat', async () => {
    expect((await runEvals({ cases: [c] })).totals.runs).toBe(3);
    expect((await runEvals({ cases: [c], repeat: 2 })).totals.runs).toBe(2);
    expect(countRuns({ cases: [c, { ...c, repeat: undefined }] })).toBe(4);
    expect(countRuns({ cases: [c, { ...c, repeat: undefined }], repeat: 5 })).toBe(10);
  });

  it('never runs more cases at once than the concurrency allows', async () => {
    let inFlight = 0;
    let most = 0;
    mocked.mockImplementation(async (prompt) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return reply(prompt) as never;
    });

    await runEvals({ cases: [c], repeat: 8, concurrency: 3 });
    expect(most).toBe(3);

    most = 0;
    await runEvals({ cases: [c], repeat: 4 });
    expect(most).toBe(1); // sequential by default
  });

  it('refuses a concurrency outside 1 to 4', async () => {
    await expect(runEvals({ cases: [c], concurrency: 5 })).rejects.toThrow(/from 1 to 4/);
  });
});

describe('guidance', () => {
  const validate = (extra: Partial<EvalCase> = {}) =>
    kase('validate', { endpoint: payout, data: { holder: 'h' } }, { valid: true }, extra);
  const promptOf = () => mocked.mock.calls[0][0];

  it('the run\'s config and flow reach the prompt, with step guidance matched by endpoint id', async () => {
    await runEvals({
      cases: [validate()],
      config: { guidance: { extraRules: { validate: ['Holder names are uppercase.'] } } },
      flow: { id: 'f', title: 't', description: 'd', guidance: 'Small sellers.', endpoints: [{ ...payout, guidance: 'Match the legal name.' }] },
    });

    expect(promptOf()).toContain('- Holder names are uppercase.');
    expect(promptOf()).toContain('About this form: Small sellers.');
    expect(promptOf()).toContain('Guidance for the step "Payout": Match the legal name.');
  });

  it('a case\'s fixtures replace the run\'s guidance for that case', async () => {
    await runEvals({
      cases: [validate({ fixtures: { config: { guidance: { tone: 'Case tone.' } }, flow: null } })],
      config: { guidance: { tone: 'Run tone.' } },
    });

    expect(promptOf()).toContain('Tone: Case tone.');
    expect(promptOf()).not.toContain('Run tone.');
  });

  it('without guidance, the prompt has no guidance block', async () => {
    await runEvals({ cases: [validate()] });
    expect(promptOf()).not.toContain('AUTHOR_GUIDANCE');
  });
});

describe('the report', () => {
  it('has per-call summaries, totals, the provider and model, and every prompt version', async () => {
    vi.stubEnv('LLM_PROVIDER', 'openrouter');
    vi.stubEnv('LLM_MODEL', 'some/model');
    const report = await runEvals({
      cases: [
        kase('selectFields', { endpoint: verification }, { mustInclude: ['dob'] }),
        kase('validate', { endpoint: payout, data: {} }, { valid: false }),
      ],
      calls: ['selectFields', 'validate', 'classifyFailure'],
    });

    expect(report).toMatchObject({
      provider: 'openrouter',
      model: 'some/model',
      promptVersions: { generation: 1, selectFields: 1, validate: 2, invalidation: 1, classifyFailure: 1, guidanceBlock: 1 },
      totals: { runs: 2, passed: 1, failed: 1, degraded: 0, passRate: 0.5 },
    });
    expect(Object.keys(report.calls)).toEqual(['selectFields', 'validate']);
    expect(report.calls.selectFields).toMatchObject({ runs: 1, passed: 1, passRate: 1, failures: [] });
    expect(report.calls.selectFields!.p50Ms).toBeGreaterThanOrEqual(0);
    expect(report.calls.selectFields!.p95Ms).toBeGreaterThanOrEqual(report.calls.selectFields!.p50Ms);
  });

  it('only runs the selected calls', async () => {
    await runEvals({ cases: [kase('selectFields', { endpoint: verification }, { mustInclude: ['dob'] })], calls: ['validate'] });
    expect(mocked).not.toHaveBeenCalled();
  });
});

describe('static mode', () => {
  it('refuses to run, since every call would only take its fallback', async () => {
    vi.stubEnv('AGENTINTAKE_STATIC_MODE', '1');
    await expect(runEvals({ cases: [] })).rejects.toThrow(/AGENTINTAKE_STATIC_MODE is on/);
    expect(mocked).not.toHaveBeenCalled();
  });
});
