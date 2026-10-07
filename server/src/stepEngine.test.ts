import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FieldDef } from './flowSchema.js';

vi.mock('./llmClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./llmClient.js')>()),
  generateStructured: vi.fn(),
}));

import { generateStructured, LlmTimeoutError } from './llmClient.js';
import { selectStepFields, STEP_TIMEOUT_MS, validateStepSubmission } from './stepEngine.js';

const mockedGenerateStructured = vi.mocked(generateStructured);

const baseFields: FieldDef[] = [
  { name: 'email', type: 'string', label: 'Email', required: true },
  { name: 'yearsOfExperience', type: 'number', label: 'Years of experience', required: false },
  {
    name: 'employmentStatus',
    type: 'enum',
    label: 'Employment status',
    required: true,
    enumValues: ['employed', 'unemployed'],
  },
];

const endpoint = {
  id: 'createCandidate',
  title: 'Your Details',
  description: 'Tell us about yourself.',
  fields: baseFields,
};

beforeEach(() => {
  mockedGenerateStructured.mockReset();
});

afterEach(() => {
  delete process.env.AGENTINTAKE_STATIC_MODE;
});

describe('selectStepFields', () => {
  it('returns the full base list without calling the LLM when the endpoint has no fields', async () => {
    const result = await selectStepFields({ endpoint: { ...endpoint, fields: [] } });

    expect(result).toEqual({ fields: [], suggestedValues: {}, degraded: false });
    expect(mockedGenerateStructured).not.toHaveBeenCalled();
  });

  it('reports degraded: false for a no-fields endpoint even with AGENTINTAKE_STATIC_MODE on', async () => {
    process.env.AGENTINTAKE_STATIC_MODE = 'true';

    const result = await selectStepFields({ endpoint: { ...endpoint, fields: [] } });

    expect(result).toEqual({ fields: [], suggestedValues: {}, degraded: false });
    expect(mockedGenerateStructured).not.toHaveBeenCalled();
  });

  it('returns the full base list without calling the LLM when AGENTINTAKE_STATIC_MODE is on', async () => {
    process.env.AGENTINTAKE_STATIC_MODE = 'true';

    const result = await selectStepFields({ endpoint });

    expect(result.fields).toEqual(baseFields);
    expect(result.degraded).toBe(true);
    expect(mockedGenerateStructured).not.toHaveBeenCalled();
  });

  it('returns an LLM-adapted subset, reordered, with a description override and suggestions', async () => {
    mockedGenerateStructured.mockResolvedValueOnce({
      fields: [
        { name: 'employmentStatus' },
        { name: 'email', descriptionOverride: 'We already have a hint this is your work email.' },
      ],
      suggestedValues: { employmentStatus: 'employed' },
    });

    const result = await selectStepFields({ endpoint });

    expect(result.degraded).toBe(false);
    expect(result.fields.map((f) => f.name)).toEqual(['employmentStatus', 'email']);
    expect(result.fields[1].description).toBe('We already have a hint this is your work email.');
    expect(result.suggestedValues).toEqual({ employmentStatus: 'employed' });
  });

  it('CRITICAL: falls back to the full base list when the LLM invents a field outside the base list', async () => {
    // Simulate exactly what generateStructured does for real: validate the
    // model's raw output against the schema it was given. A hallucinated
    // field name fails the dynamic enum built from the endpoint's own
    // fields, so this throws -- the "no invented fields" guardrail, enforced
    // structurally rather than by a post-hoc filter.
    mockedGenerateStructured.mockImplementationOnce(async (_prompt, schema) => {
      return schema.parse({
        fields: [{ name: 'ssn' }], // not a real field on this endpoint
        suggestedValues: {},
      });
    });

    const result = await selectStepFields({ endpoint });

    expect(result.degraded).toBe(true);
    expect(result.fields).toEqual(baseFields);
    expect(result.fields.some((f) => f.name === 'ssn')).toBe(false);
  });

  it('falls back to the full base list when the LLM call rejects (network error/timeout)', async () => {
    mockedGenerateStructured.mockRejectedValueOnce(new Error('upstream timeout'));

    const result = await selectStepFields({ endpoint });

    expect(result).toEqual({ fields: baseFields, suggestedValues: {}, degraded: true });
  });

  it('falls back to the full base list when the LLM returns a structurally valid but empty field list', async () => {
    mockedGenerateStructured.mockResolvedValueOnce({ fields: [], suggestedValues: {} });

    const result = await selectStepFields({ endpoint });

    expect(result).toEqual({ fields: baseFields, suggestedValues: {}, degraded: true });
  });
});

describe('validateStepSubmission', () => {
  it('skips the LLM call and reports valid when the endpoint has no fields', async () => {
    const result = await validateStepSubmission({
      endpoint: { ...endpoint, fields: [] },
      data: {},
    });

    expect(mockedGenerateStructured).not.toHaveBeenCalled();
    expect(result).toEqual({ valid: true, errors: {}, degraded: false });
  });

  it('reports degraded: false for a no-fields endpoint even with AGENTINTAKE_STATIC_MODE on (matches selectStepFields)', async () => {
    process.env.AGENTINTAKE_STATIC_MODE = 'true';

    const result = await validateStepSubmission({
      endpoint: { ...endpoint, fields: [] },
      data: {},
    });

    expect(mockedGenerateStructured).not.toHaveBeenCalled();
    expect(result).toEqual({ valid: true, errors: {}, degraded: false });
  });

  it('skips the LLM call and reports valid (degraded) when AGENTINTAKE_STATIC_MODE is on', async () => {
    process.env.AGENTINTAKE_STATIC_MODE = 'true';

    const result = await validateStepSubmission({
      endpoint,
      data: { email: 'a@b.com' },
    });

    expect(mockedGenerateStructured).not.toHaveBeenCalled();
    expect(result).toEqual({ valid: true, errors: {}, degraded: true });
  });

  it('reports valid when the semantic check passes', async () => {
    mockedGenerateStructured.mockResolvedValueOnce({ valid: true, errors: [] });

    const result = await validateStepSubmission({
      endpoint,
      data: { email: 'a@b.com' },
    });

    expect(result).toEqual({ valid: true, errors: {}, degraded: false });
  });

  it('reports invalid with inline errors when the semantic check fails', async () => {
    mockedGenerateStructured.mockResolvedValueOnce({
      valid: false,
      errors: [{ name: 'yearsOfExperience', message: 'Implausibly high for the stated role.' }],
    });

    const result = await validateStepSubmission({
      endpoint,
      data: { yearsOfExperience: 999 },
    });

    expect(result).toEqual({
      valid: false,
      errors: { yearsOfExperience: 'Implausibly high for the stated role.' },
      degraded: false,
    });
  });

  it('CRITICAL: degrades to accepting the data when the LLM reports an error for a field outside the base list', async () => {
    // Same mechanism as selectStepFields's guardrail test: this simulates
    // generateStructured's real Zod validation rejecting a hallucinated
    // field name in "errors", which this function must treat as any other
    // failure -- degrade to "accept the data," never let a fabricated
    // field name reach the caller.
    mockedGenerateStructured.mockImplementationOnce(async (_prompt, schema) => {
      return schema.parse({
        valid: false,
        errors: [{ name: 'ssn', message: 'looks fake' }], // not a real field
      });
    });

    const result = await validateStepSubmission({
      endpoint,
      data: { email: 'a@b.com' },
    });

    expect(result).toEqual({ valid: true, errors: {}, degraded: true });
  });

  it('degrades to accepting the data when the LLM call rejects (network error/timeout)', async () => {
    mockedGenerateStructured.mockRejectedValueOnce(new Error('upstream timeout'));

    const result = await validateStepSubmission({
      endpoint,
      data: { email: 'a@b.com' },
    });

    expect(result).toEqual({ valid: true, errors: {}, degraded: true });
  });
});

describe('step engine timeouts', () => {
  it('asks llmClient to abort both per-step calls after STEP_TIMEOUT_MS', async () => {
    mockedGenerateStructured
      .mockResolvedValueOnce({ fields: [{ name: 'email' }], suggestedValues: {} })
      .mockResolvedValueOnce({ valid: true, errors: [] });

    await selectStepFields({ endpoint });
    await validateStepSubmission({ endpoint, data: { email: 'a@b.com' } });

    for (const call of mockedGenerateStructured.mock.calls) {
      expect(call[2]).toEqual({ timeoutMs: STEP_TIMEOUT_MS });
    }
  });

  it('degrades both calls when the request is aborted for taking too long', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockedGenerateStructured
      .mockRejectedValueOnce(new LlmTimeoutError('The model did not respond within 15 seconds.'))
      .mockRejectedValueOnce(new LlmTimeoutError('The model did not respond within 15 seconds.'));

    const fields = await selectStepFields({ endpoint });
    const verdict = await validateStepSubmission({ endpoint, data: { email: 'a@b.com' } });

    expect(fields).toEqual({ fields: baseFields, suggestedValues: {}, degraded: true });
    expect(verdict).toEqual({ valid: true, errors: {}, degraded: true });
    warn.mockRestore();
  });
});
