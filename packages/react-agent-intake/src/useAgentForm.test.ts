// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EndpointDef, FieldDef, FlowDef } from '../../../server/src/flowSchema.js';
import { useAgentForm } from './useAgentForm.js';

const step1Fields: FieldDef[] = [{ name: 'email', type: 'string', label: 'Email', required: true }];
const step2Fields: FieldDef[] = [{ name: 'role', type: 'string', label: 'Role', required: true }];

function makeFlow(execute1: EndpointDef['execute'], execute2: EndpointDef['execute'] = vi.fn()): FlowDef {
  return {
    id: 'test-flow',
    title: 'Test Flow',
    description: 'A test flow.',
    endpoints: [
      { id: 'step1', title: 'Step 1', fields: step1Fields, execute: execute1 },
      { id: 'step2', title: 'Step 2', fields: step2Fields, execute: execute2 },
    ],
  };
}

function mockFetch(handlers: {
  fields?: (body: unknown) => unknown;
  validate?: (body: unknown) => unknown;
  failFields?: boolean;
  failValidate?: boolean;
}) {
  return vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (url.endsWith('/api/step/fields')) {
      if (handlers.failFields) throw new Error('network error (fields)');
      const requestedFields = (body as { endpoint: { fields: FieldDef[] } }).endpoint.fields;
      const result = handlers.fields?.(body) ?? { fields: requestedFields, suggestedValues: {}, degraded: false };
      return { ok: true, status: 200, json: async () => result } as Response;
    }
    if (url.endsWith('/api/step/validate')) {
      if (handlers.failValidate) throw new Error('network error (validate)');
      const result = handlers.validate?.(body) ?? { valid: true, errors: {}, degraded: false };
      return { ok: true, status: 200, json: async () => result } as Response;
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch({}));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useAgentForm', () => {
  it('fetches adapted fields on mount and pre-fills suggestedValues', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        fields: () => ({
          fields: step1Fields,
          suggestedValues: { email: 'suggested@example.com' },
          degraded: false,
        }),
      })
    );
    const execute1 = vi.fn().mockResolvedValue({ success: true });
    const flow = makeFlow(execute1);

    const { result } = renderHook(() => useAgentForm(flow, { apiUrl: 'http://test.local' }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.currentStepFields).toEqual(step1Fields);
    expect(result.current.suggestedValues).toEqual({ email: 'suggested@example.com' });
    expect(result.current.values.email).toBe('suggested@example.com');
  });

  it('happy path: valid -> executing -> complete, and advances to the next step', async () => {
    const execute1 = vi.fn().mockResolvedValue({ success: true, message: 'Created.' });
    const flow = makeFlow(execute1);
    const { result } = renderHook(() => useAgentForm(flow, { apiUrl: 'http://test.local' }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.updateField('email', 'a@b.com'));
    await act(() => result.current.submitStep());

    expect(execute1).toHaveBeenCalledWith({ email: 'a@b.com' }, { getAuthHeaders: undefined });
    expect(result.current.completedEndpoints).toEqual(['step1']);
    expect(result.current.currentStepIndex).toBe(1);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.currentStepStatus).toBe('idle'); // fresh status for step2
  });

  it('isComplete only becomes true once every endpoint has reached complete', async () => {
    const execute1 = vi.fn().mockResolvedValue({ success: true });
    const execute2 = vi.fn().mockResolvedValue({ success: true });
    const flow = makeFlow(execute1, execute2);
    const { result } = renderHook(() => useAgentForm(flow, { apiUrl: 'http://test.local' }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.updateField('email', 'a@b.com'));
    await act(() => result.current.submitStep());

    expect(result.current.isComplete).toBe(false);

    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.updateField('role', 'engineer'));
    await act(() => result.current.submitStep());

    expect(result.current.isComplete).toBe(true);
    expect(result.current.completedEndpoints).toEqual(['step1', 'step2']);
  });

  it('invalid: a semantic rejection sets currentStepStatus to invalid and never calls execute()', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        validate: () => ({ valid: false, errors: { email: 'Looks fake.' }, degraded: false }),
      })
    );
    const execute1 = vi.fn().mockResolvedValue({ success: true });
    const flow = makeFlow(execute1);
    const { result } = renderHook(() => useAgentForm(flow, { apiUrl: 'http://test.local' }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.updateField('email', 'not-an-email'));
    await act(() => result.current.submitStep());

    expect(result.current.currentStepStatus).toBe('invalid');
    expect(result.current.errors).toEqual({ email: 'Looks fake.' });
    expect(execute1).not.toHaveBeenCalled();
  });

  it('fast client-side validation rejects a missing required field before any network call to /api/step/validate', async () => {
    const fetchMock = mockFetch({});
    vi.stubGlobal('fetch', fetchMock);
    const execute1 = vi.fn().mockResolvedValue({ success: true });
    const flow = makeFlow(execute1);
    const { result } = renderHook(() => useAgentForm(flow, { apiUrl: 'http://test.local' }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    fetchMock.mockClear(); // clear the initial /api/step/fields call

    await act(() => result.current.submitStep()); // email left empty

    expect(result.current.currentStepStatus).toBe('invalid');
    expect(result.current.errors.email).toMatch(/required/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(execute1).not.toHaveBeenCalled();
  });

  it('executionFailed -> retryExecution() -> complete, without re-running semantic validation', async () => {
    const execute1 = vi
      .fn()
      .mockResolvedValueOnce({ success: false, message: 'Downstream API rejected the request.' })
      .mockResolvedValueOnce({ success: true });
    const flow = makeFlow(execute1);
    const fetchMock = mockFetch({});
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAgentForm(flow, { apiUrl: 'http://test.local' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.updateField('email', 'a@b.com'));
    await act(() => result.current.submitStep());

    expect(result.current.currentStepStatus).toBe('executionFailed');
    expect(result.current.executionError).toBe('Downstream API rejected the request.');

    const validateCallsBeforeRetry = fetchMock.mock.calls.filter(([url]) =>
      (url as string).endsWith('/api/step/validate')
    ).length;

    await act(() => result.current.retryExecution());

    // Completing step1 advances currentStepIndex to step2, so check
    // completedEndpoints rather than currentStepStatus (which now reflects
    // step2's fresh 'idle' status, not step1's).
    expect(result.current.completedEndpoints).toEqual(['step1']);
    expect(execute1).toHaveBeenCalledTimes(2);
    const validateCallsAfterRetry = fetchMock.mock.calls.filter(([url]) =>
      (url as string).endsWith('/api/step/validate')
    ).length;
    expect(validateCallsAfterRetry).toBe(validateCallsBeforeRetry); // no extra validation call
  });

  it('executionFailed when execute() throws (not just returns {success:false})', async () => {
    const execute1 = vi.fn().mockRejectedValueOnce(new Error('Network down.'));
    const flow = makeFlow(execute1);
    vi.stubGlobal('fetch', mockFetch({}));

    const { result } = renderHook(() => useAgentForm(flow, { apiUrl: 'http://test.local' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.updateField('email', 'a@b.com'));
    await act(() => result.current.submitStep());

    expect(result.current.currentStepStatus).toBe('executionFailed');
    expect(result.current.executionError).toBe('Network down.');
  });

  it('sets a fatal error (not a throw) when the flow has no endpoints at all', async () => {
    const emptyFlow: FlowDef = { id: 'empty', title: 'Empty', description: 'No endpoints.', endpoints: [] };
    vi.stubGlobal('fetch', mockFetch({}));

    const { result } = renderHook(() => useAgentForm(emptyFlow, { apiUrl: 'http://test.local' }));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toMatch(/no endpoints/);
  });

  it('updateField resets an invalid/executionFailed status back to idle', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ validate: () => ({ valid: false, errors: { email: 'bad' }, degraded: false }) })
    );
    const flow = makeFlow(vi.fn());
    const { result } = renderHook(() => useAgentForm(flow, { apiUrl: 'http://test.local' }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.updateField('email', 'x'));
    await act(() => result.current.submitStep());
    expect(result.current.currentStepStatus).toBe('invalid');

    act(() => result.current.updateField('email', 'y'));
    expect(result.current.currentStepStatus).toBe('idle');
    expect(result.current.errors).toEqual({});
  });

  it('degrades client-side to the full base field list when /api/step/fields itself fails', async () => {
    vi.stubGlobal('fetch', mockFetch({ failFields: true }));
    const flow = makeFlow(vi.fn());
    const { result } = renderHook(() => useAgentForm(flow, { apiUrl: 'http://test.local' }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.currentStepFields).toEqual(step1Fields);
    expect(result.current.error).toBeNull();
  });

  it('degrades client-side to accepting the data when /api/step/validate itself fails, and still executes', async () => {
    vi.stubGlobal('fetch', mockFetch({ failValidate: true }));
    const execute1 = vi.fn().mockResolvedValue({ success: true });
    const flow = makeFlow(execute1);
    const { result } = renderHook(() => useAgentForm(flow, { apiUrl: 'http://test.local' }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.updateField('email', 'a@b.com'));
    await act(() => result.current.submitStep());

    expect(execute1).toHaveBeenCalled();
    expect(result.current.completedEndpoints).toEqual(['step1']);
  });

  it('aborts the in-flight /api/step/fields fetch on unmount', async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        capturedSignal = init.signal as AbortSignal;
        return new Promise(() => {}); // never resolves
      })
    );
    const flow = makeFlow(vi.fn());
    const { unmount } = renderHook(() => useAgentForm(flow, { apiUrl: 'http://test.local' }));

    expect(capturedSignal?.aborted).toBe(false);
    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });
});
