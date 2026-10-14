// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecuteFn, FieldDef, FlowDef } from './contracts.js';
import { useAgentForm } from './useAgentForm.js';

const step1Fields: FieldDef[] = [{ name: 'email', type: 'string', label: 'Email', required: true }];
const step2Fields: FieldDef[] = [{ name: 'role', type: 'string', label: 'Role', required: true }];

function makeFlow(execute1: ExecuteFn, execute2: ExecuteFn = vi.fn()): FlowDef {
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

    expect(execute1).toHaveBeenCalledWith(
      { email: 'a@b.com' },
      { getAuthHeaders: undefined, results: {}, idempotencyKey: expect.any(String) }
    );
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

describe('useAgentForm stability', () => {
  it('keeps typed values and does not refetch when the host passes an equal but new flow object', async () => {
    const fetchMock = mockFetch({});
    vi.stubGlobal('fetch', fetchMock);
    const execute1 = vi.fn().mockResolvedValue({ success: true });

    const { result, rerender } = renderHook(({ flow }) => useAgentForm(flow, { apiUrl: 'http://test.local' }), {
      initialProps: { flow: makeFlow(execute1) },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.updateField('email', 'typed@b.com'));

    rerender({ flow: makeFlow(execute1) });

    expect(result.current.values.email).toBe('typed@b.com');
    expect(fetchMock.mock.calls.filter(([url]) => (url as string).endsWith('/api/step/fields'))).toHaveLength(1);
  });

  it('still works where crypto.randomUUID is unavailable (plain HTTP, non-localhost)', async () => {
    const fetchMock = mockFetch({});
    vi.stubGlobal('fetch', fetchMock);
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });

    try {
      const { result } = renderHook(() => useAgentForm(makeFlow(vi.fn()), { apiUrl: 'http://test.local' }));
      await waitFor(() => expect(result.current.loading).toBe(false));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.sessionId).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true });
    }
  });
});

describe('useAgentForm operations', () => {
  async function completeStep1(result: ReturnType<typeof renderHook<ReturnType<typeof useAgentForm>, unknown>>['result']) {
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.updateField('email', 'a@b.com'));
    await act(() => result.current.submitStep());
    await waitFor(() => expect(result.current.loading).toBe(false));
  }

  it('passes earlier steps results (e.g. a created id) to later steps via ctx.results', async () => {
    const create1 = vi.fn().mockResolvedValue({ success: true, resourceId: 'acct_1', output: { tier: 'gold' } });
    const create2 = vi.fn().mockResolvedValue({ success: true });
    const { result } = renderHook(() => useAgentForm(makeFlow(create1, create2), { apiUrl: 'http://test.local' }));

    await completeStep1(result);
    act(() => result.current.updateField('role', 'engineer'));
    await act(() => result.current.submitStep());

    expect(create2).toHaveBeenCalledWith(
      { role: 'engineer' },
      expect.objectContaining({ results: { step1: { success: true, resourceId: 'acct_1', output: { tier: 'gold' } } } })
    );
  });

  it('records values and the create result per step in stepRecords', async () => {
    const create1 = vi.fn().mockResolvedValue({ success: true, resourceId: 'acct_1' });
    const { result } = renderHook(() => useAgentForm(makeFlow(create1), { apiUrl: 'http://test.local' }));

    await completeStep1(result);

    expect(result.current.stepRecords.step1).toEqual({
      endpointId: 'step1',
      status: 'complete',
      values: { email: 'a@b.com' },
      fieldNames: ['email'],
      result: { success: true, resourceId: 'acct_1' },
    });
  });

  it('accepts operations.create in place of execute', async () => {
    const create = vi.fn().mockResolvedValue({ success: true, resourceId: 'x' });
    const flow: FlowDef = {
      id: 'ops',
      title: 'Ops',
      description: 'd',
      endpoints: [{ id: 'step1', title: 'Step 1', fields: step1Fields, operations: { create } }],
    };
    const { result } = renderHook(() => useAgentForm(flow, { apiUrl: 'http://test.local' }));

    await completeStep1(result);

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.current.isComplete).toBe(true);
  });

  it('keeps the same idempotency key across a retry, and uses a new one after the user edits', async () => {
    const execute1 = vi
      .fn()
      .mockResolvedValueOnce({ success: false, message: 'timeout' })
      .mockResolvedValueOnce({ success: false, message: 'timeout' })
      .mockResolvedValueOnce({ success: true });
    const { result } = renderHook(() => useAgentForm(makeFlow(execute1), { apiUrl: 'http://test.local' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.updateField('email', 'a@b.com'));
    await act(() => result.current.submitStep());
    await act(() => result.current.retryExecution());
    act(() => result.current.updateField('email', 'c@d.com'));
    await act(() => result.current.submitStep());

    const keys = execute1.mock.calls.map((call) => call[1].idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('normalizes a failure without a cause, and a thrown error, into failure.kind "other"', async () => {
    const execute1 = vi
      .fn()
      .mockResolvedValueOnce({ success: false, message: 'Nope.' })
      .mockRejectedValueOnce(new Error('Boom.'));
    const { result } = renderHook(() => useAgentForm(makeFlow(execute1), { apiUrl: 'http://test.local' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.updateField('email', 'a@b.com'));
    await act(() => result.current.submitStep());
    expect(result.current.stepRecords.step1.result?.failure).toEqual({ kind: 'other', message: 'Nope.' });

    await act(() => result.current.retryExecution());
    expect(result.current.stepRecords.step1.result).toEqual({
      success: false,
      message: 'Boom.',
      failure: { kind: 'other', message: 'Boom.' },
    });
    expect(result.current.executionError).toBe('Boom.');
  });

  it('warns once when read/update/undo are implemented but create returned no resourceId', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const flow: FlowDef = {
      id: 'ops',
      title: 'Ops',
      description: 'd',
      endpoints: [
        {
          id: 'step1',
          title: 'Step 1',
          fields: step1Fields,
          operations: { create: vi.fn().mockResolvedValue({ success: true }), undo: vi.fn() },
        },
      ],
    };
    const { result } = renderHook(() => useAgentForm(flow, { apiUrl: 'http://test.local' }));

    await completeStep1(result);

    expect(warn.mock.calls.filter(([message]) => String(message).includes('returned no resourceId'))).toHaveLength(1);
    warn.mockRestore();
  });

  it('sends the implemented capabilities (never the functions) to the server', async () => {
    const fetchMock = mockFetch({});
    vi.stubGlobal('fetch', fetchMock);
    const flow: FlowDef = {
      id: 'ops',
      title: 'Ops',
      description: 'd',
      endpoints: [
        { id: 'step1', title: 'Step 1', fields: step1Fields, operations: { create: vi.fn(), read: vi.fn(), undo: vi.fn() } },
      ],
    };
    const { result } = renderHook(() => useAgentForm(flow, { apiUrl: 'http://test.local' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string).endpoint;
    expect(sent.capabilities).toEqual({ read: true, update: false, undo: true });
    expect(sent).not.toHaveProperty('operations');
    expect(sent).not.toHaveProperty('execute');
  });

  it('after a step completes, moves to the first step in flow order that is not complete', async () => {
    const flow: FlowDef = {
      id: 'three',
      title: 'Three',
      description: 'd',
      endpoints: [
        { id: 'step1', title: 'Step 1', fields: step1Fields, execute: vi.fn().mockResolvedValue({ success: true }) },
        { id: 'step2', title: 'Step 2', fields: step2Fields, execute: vi.fn().mockResolvedValue({ success: true }) },
        { id: 'step3', title: 'Step 3', fields: [], execute: vi.fn().mockResolvedValue({ success: true }) },
      ],
    };
    const { result } = renderHook(() => useAgentForm(flow, { apiUrl: 'http://test.local' }));

    await completeStep1(result);
    expect(result.current.currentStepIndex).toBe(1);

    act(() => result.current.updateField('role', 'engineer'));
    await act(() => result.current.submitStep());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.currentStepIndex).toBe(2);

    await act(() => result.current.submitStep());
    expect(result.current.isComplete).toBe(true);
    expect(result.current.currentStepIndex).toBe(2);
  });
});

describe('useAgentForm sends the flow\'s author guidance', () => {
  it('sends the flow id, flow guidance and language, and the step\'s guidance', async () => {
    const fetchMock = mockFetch({});
    vi.stubGlobal('fetch', fetchMock);
    const flow: FlowDef = {
      ...makeFlow(vi.fn().mockResolvedValue({ success: true })),
      guidance: 'Small businesses.',
      outputLanguage: 'es-MX',
    };
    flow.endpoints[0] = { ...flow.endpoints[0], guidance: 'Use the work email.' } as FlowDef['endpoints'][number];
    const { result } = renderHook(() => useAgentForm(flow, { apiUrl: 'http://test.local' }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.updateField('email', 'a@example.com'));
    await act(() => result.current.submitStep());

    for (const [url, init] of fetchMock.mock.calls) {
      const body = JSON.parse(init.body as string);
      expect(body.flow, url).toEqual({ id: 'test-flow', guidance: 'Small businesses.', outputLanguage: 'es-MX' });
      expect(body.endpoint.guidance, url).toBe(body.endpoint.id === 'step1' ? 'Use the work email.' : undefined);
    }
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/api/step/fields', '/api/step/validate', '/api/step/fields']);
  });

  it('a flow without guidance sends only its id', async () => {
    const fetchMock = mockFetch({});
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAgentForm(makeFlow(vi.fn()), { apiUrl: 'http://test.local' }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).flow).toEqual({ id: 'test-flow' });
  });
});
