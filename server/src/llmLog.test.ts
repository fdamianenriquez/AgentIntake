import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./llmClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./llmClient.js')>()),
  generateStructured: vi.fn(),
}));

import { APICallError, LoadAPIKeyError, NoObjectGeneratedError, RetryError, TypeValidationError } from 'ai';
import { createApp } from './app.js';
import { withDegradationCapture } from './degradation.js';
import { buildModel, generateStructured, LlmTimeoutError, resolveProvider } from './llmClient.js';
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
    mocked.mockRejectedValueOnce(new LlmTimeoutError('The model did not respond within 15 seconds.'));
    await validate();

    expect(lines).toEqual([
      `stepEngine: validateStepSubmission("payout") degraded to the fallback path (timeout) [call=validate prompt=v2 guidanceBlock=v1 guidance=${guidanceHash(guidance)}]`,
    ]);
  });

  it('is not logged when the level is error', async () => {
    vi.stubEnv('AGENTINTAKE_LOG_LEVEL', 'error');
    mocked.mockRejectedValueOnce(new Error('x'));
    await validate();
    expect(lines).toEqual([]);
  });
});

// The error a real llmClient function throws under the given environment.
function thrownBy(fn: () => unknown, env: Record<string, string>): unknown {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    fn();
  } catch (error) {
    return error;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  throw new Error('expected a throw');
}

describe("the degradation warning's reason", () => {
  // Error text from the provider or the SDK isn't under this project's
  // control and can echo the model's output, which can echo what the user
  // typed; the warning names a fixed reason instead.
  const MARKER = 'ECHOED-VALUE-5d1e';
  const apiError = (statusCode?: number) =>
    new APICallError({ message: `Bad request: ${MARKER}`, url: 'https://provider.test/v1', requestBodyValues: { MARKER }, statusCode });
  const cases: [string, () => unknown, string][] = [
    ['an SDK type-validation error', () => new TypeValidationError({ value: { bank: MARKER }, cause: new Error(MARKER) }), 'invalid output'],
    [
      'output that did not match the schema',
      () =>
        new NoObjectGeneratedError({
          message: `No object generated: ${MARKER}`,
          text: `{"bank":"${MARKER}"}`,
          response: { id: 'r', timestamp: new Date(), modelId: 'm' },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as never,
          finishReason: 'stop',
        }),
      'invalid output',
    ],
    ['a provider error with a status', () => apiError(429), 'provider error 429'],
    ['a provider error without a status', () => apiError(), 'provider error'],
    [
      'a provider error after retries',
      () => new RetryError({ message: `Failed after 3 attempts. Last error: ${MARKER}`, reason: 'maxRetriesExceeded', errors: [apiError(503)] }),
      'provider error 503',
    ],
    ['a timeout', () => new LlmTimeoutError('The model did not respond within 15 seconds.'), 'timeout'],
    ['an aborted request', () => new DOMException(`aborted ${MARKER}`, 'AbortError'), 'aborted'],
    ['a plain error', () => new Error(`Something broke: ${MARKER}`), 'unknown'],
    ['a thrown non-error', () => `raw ${MARKER}`, 'unknown'],
    ['a missing API key', () => thrownBy(() => buildModel('anthropic'), { LLM_API_KEY: '' }), 'configuration error'],
    ['an unsupported LLM_PROVIDER', () => thrownBy(resolveProvider, { LLM_PROVIDER: 'nope' }), 'configuration error'],
    ['an SDK key-loading error', () => new LoadAPIKeyError({ message: 'API key is missing.' }), 'configuration error'],
  ];

  for (const [what, error, reason] of cases) {
    it(`for ${what} is "${reason}", without the error's text`, async () => {
      vi.stubEnv('AGENTINTAKE_LOG_LEVEL', 'debug');
      mocked.mockRejectedValueOnce(error());
      await validate(false);

      expect(lines).toContain(
        `stepEngine: validateStepSubmission("payout") degraded to the fallback path (${reason}) [call=validate prompt=v2 guidanceBlock=v1 guidance=none]`
      );
      for (const line of lines) expect(line).not.toContain(MARKER);
    });
  }

  it('the degradation capture still receives the full message', async () => {
    mocked.mockRejectedValueOnce(new TypeValidationError({ value: { bank: MARKER }, cause: new Error('c') }));
    const { degradations } = await withDegradationCapture(() => validate(false));

    expect(degradations).toHaveLength(1);
    expect(degradations[0].message).toContain(MARKER);
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
