import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./llmClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./llmClient.js')>()),
  generateStructured: vi.fn(async () => {
    throw new Error('The model did not respond within 15 seconds.');
  }),
}));

import { withDegradationCapture } from './degradation.js';
import { validateStepSubmission } from './stepEngine.js';

const endpoint = { id: 'payout', title: 'Payout', fields: [{ name: 'bank', type: 'string' as const, label: 'Bank', required: true }] };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('degradation reports', () => {
  it('outside a capture (every runtime request), the fallback is logged as before', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await validateStepSubmission({ endpoint, data: { bank: 'B' } });

    expect(result.degraded).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      'stepEngine: validateStepSubmission("payout") degraded to the fallback path -- The model did not respond within 15 seconds. [call=validate prompt=v2 guidanceBlock=v1 guidance=none]'
    );
  });

  it('inside a capture, the reason is collected instead of logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result, degradations } = await withDegradationCapture(() => validateStepSubmission({ endpoint, data: { bank: 'B' } }));

    expect(result.degraded).toBe(true);
    expect(degradations).toEqual([
      { call: 'validateStepSubmission', endpointId: 'payout', message: 'The model did not respond within 15 seconds.' },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });
});
