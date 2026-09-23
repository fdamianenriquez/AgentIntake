import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedEndpoint } from './flowSchema.js';
import type { FlowGenerationResult } from './flowGenerator.js';

vi.mock('./llmClient.js', () => ({
  generateStructured: vi.fn(),
}));

import { generateStructured } from './llmClient.js';
import { generateFlow } from './flowGenerator.js';

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

function validResult(): FlowGenerationResult {
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
    const result = validResult();
    mockedGenerateStructured.mockResolvedValueOnce(result);

    const output = await generateFlow({ endpoints: rawEndpoints });

    expect(output).toEqual(result);
    expect(mockedGenerateStructured).toHaveBeenCalledTimes(1);
  });

  it('retries once when the first attempt rejects, then succeeds', async () => {
    const result = validResult();
    mockedGenerateStructured
      .mockRejectedValueOnce(new Error('model returned malformed JSON'))
      .mockResolvedValueOnce(result);

    const output = await generateFlow({ endpoints: rawEndpoints });

    expect(output).toEqual(result);
    expect(mockedGenerateStructured).toHaveBeenCalledTimes(2);
  });

  it('retries once when the first attempt invents a field not in the input, then succeeds', async () => {
    const hallucinated = validResult();
    hallucinated.flow.endpoints[0].fields.push({
      name: 'salaryExpectation',
      type: 'number',
      label: 'Salary expectation',
      required: false,
    });

    mockedGenerateStructured.mockResolvedValueOnce(hallucinated).mockResolvedValueOnce(validResult());

    const output = await generateFlow({ endpoints: rawEndpoints });

    expect(output).toEqual(validResult());
    expect(mockedGenerateStructured).toHaveBeenCalledTimes(2);
  });

  it('retries once when the first attempt invents a whole new endpoint, then succeeds', async () => {
    const hallucinated = validResult();
    hallucinated.flow.endpoints.push({
      id: 'extraStep',
      title: 'Extra Step',
      fields: [],
      auth: { type: 'none' },
    });

    mockedGenerateStructured.mockResolvedValueOnce(hallucinated).mockResolvedValueOnce(validResult());

    const output = await generateFlow({ endpoints: rawEndpoints });

    expect(output).toEqual(validResult());
    expect(mockedGenerateStructured).toHaveBeenCalledTimes(2);
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

  it('includes spec title/description context in the prompt when provided', async () => {
    mockedGenerateStructured.mockResolvedValueOnce(validResult());

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
