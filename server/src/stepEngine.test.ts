import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FieldDef } from './flowSchema.js';

vi.mock('./llmClient.js', () => ({
  generateStructured: vi.fn(),
}));

import { generateStructured } from './llmClient.js';
import { selectStepFields, validateStepSubmission } from './stepEngine.js';

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
  function makeExecute(result: { success: boolean; message?: string } = { success: true }) {
    return vi.fn().mockResolvedValue(result);
  }

  it('skips the LLM call and executes directly when the endpoint has no fields', async () => {
    const execute = makeExecute();
    const result = await validateStepSubmission({
      endpoint: { ...endpoint, fields: [], execute },
      data: {},
    });

    expect(mockedGenerateStructured).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith({}, {});
    expect(result).toEqual({ success: true, errors: {}, degraded: false });
  });

  it('reports degraded: false for a no-fields endpoint even with AGENTINTAKE_STATIC_MODE on (matches selectStepFields)', async () => {
    process.env.AGENTINTAKE_STATIC_MODE = 'true';
    const execute = makeExecute();

    const result = await validateStepSubmission({
      endpoint: { ...endpoint, fields: [], execute },
      data: {},
    });

    expect(mockedGenerateStructured).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, errors: {}, degraded: false });
  });

  it('skips the LLM call and executes directly when AGENTINTAKE_STATIC_MODE is on', async () => {
    process.env.AGENTINTAKE_STATIC_MODE = 'true';
    const execute = makeExecute();

    const result = await validateStepSubmission({
      endpoint: { ...endpoint, execute },
      data: { email: 'a@b.com' },
    });

    expect(mockedGenerateStructured).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, errors: {}, degraded: true });
  });

  it('calls execute() and succeeds when the semantic check reports valid', async () => {
    mockedGenerateStructured.mockResolvedValueOnce({ valid: true, errors: [] });
    const execute = makeExecute({ success: true, message: 'Created.' });

    const result = await validateStepSubmission({
      endpoint: { ...endpoint, execute },
      data: { email: 'a@b.com' },
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, message: 'Created.', errors: {}, degraded: false });
  });

  it('does not call execute() and returns inline errors when the semantic check reports invalid', async () => {
    mockedGenerateStructured.mockResolvedValueOnce({
      valid: false,
      errors: [{ name: 'yearsOfExperience', message: 'Implausibly high for the stated role.' }],
    });
    const execute = makeExecute();

    const result = await validateStepSubmission({
      endpoint: { ...endpoint, execute },
      data: { yearsOfExperience: 999 },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      errors: { yearsOfExperience: 'Implausibly high for the stated role.' },
      degraded: false,
    });
  });

  it('CRITICAL: degrades to execute()-only when the LLM reports an error for a field outside the base list', async () => {
    mockedGenerateStructured.mockImplementationOnce(async (_prompt, schema) => {
      return schema.parse({
        valid: false,
        errors: [{ name: 'ssn', message: 'looks fake' }], // not a real field
      });
    });
    const execute = makeExecute({ success: true });

    const result = await validateStepSubmission({
      endpoint: { ...endpoint, execute },
      data: { email: 'a@b.com' },
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.degraded).toBe(true);
    expect(result.errors).toEqual({});
  });

  it('degrades to execute()-only when the LLM call rejects (network error/timeout)', async () => {
    mockedGenerateStructured.mockRejectedValueOnce(new Error('upstream timeout'));
    const execute = makeExecute({ success: true });

    const result = await validateStepSubmission({
      endpoint: { ...endpoint, execute },
      data: { email: 'a@b.com' },
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, errors: {}, degraded: true });
  });

  it("propagates execute()'s own failure after a valid semantic check", async () => {
    mockedGenerateStructured.mockResolvedValueOnce({ valid: true, errors: [] });
    const execute = makeExecute({ success: false, message: 'Downstream API rejected the request.' });

    const result = await validateStepSubmission({
      endpoint: { ...endpoint, execute },
      data: { email: 'a@b.com' },
    });

    expect(result).toEqual({
      success: false,
      message: 'Downstream API rejected the request.',
      errors: {},
      degraded: false,
    });
  });
});
