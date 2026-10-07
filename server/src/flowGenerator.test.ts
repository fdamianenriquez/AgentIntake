import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedEndpoint } from '../../packages/react-agent-intake/src/contracts.js';
import type { FlowGenerationResult } from '../../packages/react-agent-intake/src/contracts.js';

vi.mock('./llmClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./llmClient.js')>()),
  generateStructured: vi.fn(),
}));

import { generateStructured, LlmTimeoutError } from './llmClient.js';
import { generateFlow, GENERATION_TIMEOUT_MS } from './flowGenerator.js';

const mockedGenerateStructured = vi.mocked(generateStructured);

const rawEndpoints: ParsedEndpoint[] = [
  {
    id: 'createCandidate',
    title: 'POST /candidates',
    fields: [
      { name: 'email', type: 'string', label: 'Email', required: true },
      { name: 'yearsOfExperience', type: 'number', label: 'Years Of Experience', required: false },
    ],
    auth: { type: 'none' },
  },
];

// What a real generateStructured() call returns once the model's response
// passes the narrow LLM-output schema (name + optional overrides only).
function narrowLlmResult() {
  return {
    flow: {
      id: 'job-application',
      title: 'Job Application',
      description: 'Apply for a role.',
      endpoints: [
        {
          id: 'createCandidate',
          title: 'Your Details',
          description: 'Tell us about yourself.',
          fields: [
            { name: 'email', labelOverride: 'Email address' },
            { name: 'yearsOfExperience', labelOverride: 'Years of experience' },
          ],
        },
      ],
    },
    ambiguousFields: [],
  };
}

// What generateFlow() should return after expanding/rehydrating the above
// against rawEndpoints -- type/required/validation/auth come from the raw
// field, only label/description are overridden.
function expectedExpandedResult(): FlowGenerationResult {
  return {
    flow: {
      id: 'job-application',
      title: 'Job Application',
      description: 'Apply for a role.',
      endpoints: [
        {
          id: 'createCandidate',
          title: 'Your Details',
          description: 'Tell us about yourself.',
          fields: [
            { name: 'email', type: 'string', label: 'Email address', required: true },
            { name: 'yearsOfExperience', type: 'number', label: 'Years of experience', required: false },
          ],
          auth: { type: 'none' },
        },
      ],
    },
    ambiguousFields: [],
  };
}

beforeEach(() => {
  mockedGenerateStructured.mockReset();
});

describe('generateFlow', () => {
  it('passes through a valid result from the first attempt', async () => {
    mockedGenerateStructured.mockResolvedValueOnce(narrowLlmResult());

    const output = await generateFlow({ endpoints: rawEndpoints });

    expect(output).toEqual(expectedExpandedResult());
    expect(mockedGenerateStructured).toHaveBeenCalledTimes(1);
  });

  it('retries once when the first attempt rejects, then succeeds', async () => {
    mockedGenerateStructured
      .mockRejectedValueOnce(new Error('model returned malformed JSON'))
      .mockResolvedValueOnce(narrowLlmResult());

    const output = await generateFlow({ endpoints: rawEndpoints });

    expect(output).toEqual(expectedExpandedResult());
    expect(mockedGenerateStructured).toHaveBeenCalledTimes(2);
  });

  it('CRITICAL: retries once when the first attempt invents a field outside the endpoint, then succeeds', async () => {
    // Simulates exactly what generateStructured does for real: validate the
    // model's raw output against the schema it was given. A hallucinated
    // field name fails the per-endpoint enum built from that endpoint's own
    // fields, so this throws -- the "no invented fields" guardrail.
    mockedGenerateStructured.mockImplementationOnce(async (_prompt, schema) => {
      return schema.parse({
        flow: {
          id: 'job-application',
          title: 'Job Application',
          description: 'Apply for a role.',
          endpoints: [
            {
              id: 'createCandidate',
              title: 'Your Details',
              fields: [{ name: 'ssn' }], // not a real field on this endpoint
            },
          ],
        },
        ambiguousFields: [],
      });
    });
    mockedGenerateStructured.mockResolvedValueOnce(narrowLlmResult());

    const output = await generateFlow({ endpoints: rawEndpoints });

    expect(output).toEqual(expectedExpandedResult());
    expect(mockedGenerateStructured).toHaveBeenCalledTimes(2);
  });

  it('retries once when the first attempt invents a whole new endpoint, then succeeds', async () => {
    mockedGenerateStructured.mockImplementationOnce(async (_prompt, schema) => {
      return schema.parse({
        flow: {
          id: 'job-application',
          title: 'Job Application',
          description: 'Apply for a role.',
          endpoints: [
            {
              id: 'createCandidate',
              title: 'Your Details',
              fields: [{ name: 'email' }, { name: 'yearsOfExperience' }],
            },
            { id: 'extraStep', title: 'Extra Step', fields: [] }, // not an id in the input
          ],
        },
        ambiguousFields: [],
      });
    });
    mockedGenerateStructured.mockResolvedValueOnce(narrowLlmResult());

    const output = await generateFlow({ endpoints: rawEndpoints });

    expect(output).toEqual(expectedExpandedResult());
    expect(mockedGenerateStructured).toHaveBeenCalledTimes(2);
  });

  it('PROPERTY INTEGRITY: type/required/enumValues/validation always match the raw field, even if the model tries to alter them', async () => {
    mockedGenerateStructured.mockImplementationOnce(async (_prompt, schema) => {
      // The schema's shape has no "type"/"required"/"validation" keys for a
      // field entry, so a model attempting to smuggle altered values through
      // has them silently stripped by Zod -- this is what makes the
      // corruption structurally impossible rather than merely detectable.
      return schema.parse({
        flow: {
          id: 'job-application',
          title: 'Job Application',
          description: 'Apply for a role.',
          endpoints: [
            {
              id: 'createCandidate',
              title: 'Your Details',
              fields: [
                {
                  name: 'email',
                  type: 'boolean', // attempted corruption -- not part of the schema
                  required: false, // attempted corruption -- not part of the schema
                  validation: { pattern: 'anything-goes' }, // attempted corruption
                  labelOverride: 'Email address',
                },
                { name: 'yearsOfExperience', labelOverride: 'Years of experience' },
              ],
            },
          ],
        },
        ambiguousFields: [],
      });
    });

    const output = await generateFlow({ endpoints: rawEndpoints });

    const emailField = output.flow.endpoints[0].fields.find((f) => f.name === 'email')!;
    expect(emailField.type).toBe('string');
    expect(emailField.required).toBe(true);
    expect(emailField.validation).toBeUndefined();
    expect(emailField.label).toBe('Email address'); // the allowed override still applies
    expect(mockedGenerateStructured).toHaveBeenCalledTimes(1); // stripped silently, not rejected -- no retry needed
  });

  it('throws a clear error after both attempts fail', async () => {
    mockedGenerateStructured
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockRejectedValueOnce(new Error('rate limited again'));

    await expect(generateFlow({ endpoints: rawEndpoints })).rejects.toThrow(
      /failed to generate a valid flow after 2 attempts/
    );
    expect(mockedGenerateStructured).toHaveBeenCalledTimes(2);
  });

  it('passes a timeout to every generation attempt', async () => {
    mockedGenerateStructured.mockResolvedValueOnce(narrowLlmResult());

    await generateFlow({ endpoints: rawEndpoints });

    expect(mockedGenerateStructured).toHaveBeenCalledWith(expect.any(String), expect.anything(), {
      timeoutMs: GENERATION_TIMEOUT_MS,
    });
  });

  it('fails with a clear message and does NOT retry when the model times out', async () => {
    mockedGenerateStructured.mockRejectedValueOnce(new LlmTimeoutError('The model did not respond within 120 seconds.'));

    await expect(generateFlow({ endpoints: rawEndpoints })).rejects.toThrow(
      /did not respond within 120 seconds.*different model or provider/
    );
    expect(mockedGenerateStructured).toHaveBeenCalledTimes(1);
  });

  it('includes spec title/description context in the prompt when provided', async () => {
    mockedGenerateStructured.mockResolvedValueOnce(narrowLlmResult());

    await generateFlow({
      endpoints: rawEndpoints,
      specTitle: 'Job Application Intake API',
      specDescription: 'Endpoints for candidate intake.',
    });

    const [prompt] = mockedGenerateStructured.mock.calls[0];
    expect(prompt).toContain('Job Application Intake API');
    expect(prompt).toContain('Endpoints for candidate intake.');
  });
});
