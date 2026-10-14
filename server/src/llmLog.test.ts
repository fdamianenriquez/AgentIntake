import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./llmClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./llmClient.js')>()),
  generateStructured: vi.fn(),
}));

import { createApp } from './app.js';
import { generateStructured } from './llmClient.js';
import { guidanceHash } from './llmLog.js';
import { LOG_LEVELS, resolveLogLevel } from './logger.js';
import { validateStepSubmission } from './stepEngine.js';

const mocked = vi.mocked(generateStructured);
const MARKER_GUIDANCE = 'GUIDANCE-MARKER-7f3a';
const MARKER_DATA = 'DATA-MARKER-91c2';
const endpoint = { id: 'payout', title: 'Payout', fields: [{ name: 'bank', type: 'string' as const, label: 'Bank', required: true }] };
const guidance = { tone: `Formal. ${MARKER_GUIDANCE}`, rules: [`Rule ${MARKER_GUIDANCE}`] };

let lines: string[];
beforeEach(() => {
  lines = [];
  for (const method of ['debug', 'info', 'warn', 'error', 'log'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  }
  mocked.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const validate = (withGuidance = true) =>
  validateStepSubmission({ endpoint, data: { bank: MARKER_DATA }, guidance: withGuidance ? guidance : undefined });

describe('AGENTINTAKE_LOG_LEVEL', () => {
  it('defaults to warn and accepts error, warn, info and debug', () => {
    expect(resolveLogLevel({})).toBe('warn');
    for (const level of LOG_LEVELS) expect(resolveLogLevel({ AGENTINTAKE_LOG_LEVEL: level })).toBe(level);
  });

  it('an invalid value stops startup with a message naming it', () => {
    expect(() => resolveLogLevel({ AGENTINTAKE_LOG_LEVEL: 'verbose' })).toThrow(
      'AGENTINTAKE_LOG_LEVEL must be one of error, warn, info, debug (got "verbose").'
    );
    vi.stubEnv('AGENTINTAKE_LOG_LEVEL', 'verbose');
    expect(() => createApp({ config: null, trustedFlows: null })).toThrow(/AGENTINTAKE_LOG_LEVEL/);
  });
});

describe('the per-call debug line', () => {
  it('is not logged at the default level', async () => {
    mocked.mockResolvedValueOnce({ valid: true, errors: [] } as never);
    await validate();
    expect(lines).toEqual([]);
  });

  it('at debug: the call, its versions, the guidance hash, the outcome and the duration', async () => {
    vi.stubEnv('AGENTINTAKE_LOG_LEVEL', 'debug');
    mocked.mockResolvedValueOnce({ valid: true, errors: [] } as never);
    await validate();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      new RegExp(`^llm call=validate prompt=v2 guidanceBlock=v1 guidance=${guidanceHash(guidance)} outcome=ok duration=\\d+ms$`)
    );
  });

  it('says guidance=none without guidance, and outcome=degraded when the call fails', async () => {
    vi.stubEnv('AGENTINTAKE_LOG_LEVEL', 'debug');
    mocked.mockRejectedValueOnce(new Error('timed out'));
    await validate(false);

    expect(lines[0]).toMatch(/^llm call=validate prompt=v2 guidanceBlock=v1 guidance=none outcome=degraded duration=\d+ms$/);
  });

  it('never contains guidance text, the prompt, or submitted data', async () => {
    vi.stubEnv('AGENTINTAKE_LOG_LEVEL', 'debug');
    mocked.mockResolvedValueOnce({ valid: true, errors: [] } as never);
    await validate();
    mocked.mockRejectedValueOnce(new Error('the model failed'));
    await validate();

    expect(lines.length).toBeGreaterThanOrEqual(3); // two debug lines and a degradation warning
    for (const line of lines) {
      expect(line).not.toContain(MARKER_GUIDANCE);
      expect(line).not.toContain(MARKER_DATA);
      expect(line).not.toContain('You are validating');
    }
  });
});

describe('the degradation warning', () => {
  it('stays one line, at warn level, with the call, versions and guidance hash', async () => {
    mocked.mockRejectedValueOnce(new Error('The model did not respond within 15 seconds.'));
    await validate();

    expect(lines).toEqual([
      `stepEngine: validateStepSubmission("payout") degraded to the fallback path -- The model did not respond within 15 seconds. [call=validate prompt=v2 guidanceBlock=v1 guidance=${guidanceHash(guidance)}]`,
    ]);
  });

  it('is not logged when the level is error', async () => {
    vi.stubEnv('AGENTINTAKE_LOG_LEVEL', 'error');
    mocked.mockRejectedValueOnce(new Error('x'));
    await validate();
    expect(lines).toEqual([]);
  });
});

describe('guidanceHash', () => {
  it('is 12 hex characters, stable for the same guidance, different when it changes, and "none" without', () => {
    expect(guidanceHash(guidance)).toMatch(/^[0-9a-f]{12}$/);
    expect(guidanceHash({ ...guidance })).toBe(guidanceHash(guidance));
    expect(guidanceHash({ ...guidance, tone: 'Casual.' })).not.toBe(guidanceHash(guidance));
    expect(guidanceHash(undefined)).toBe('none');
    expect(guidanceHash({ rules: [] })).toBe('none'); // renders no block
  });
});
