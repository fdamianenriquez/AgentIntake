// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EndpointDef, FieldDef, FlowDef, ResourceOperations } from './contracts.js';
import { useAgentForm } from './useAgentForm.js';

const accountFields: FieldDef[] = [
  { name: 'name', type: 'string', label: 'Name', required: true },
  { name: 'type', type: 'enum', label: 'Type', required: true, enumValues: ['individual', 'business'] },
];
const detailsFields: FieldDef[] = [{ name: 'detail', type: 'string', label: 'Detail', required: true }];
const payoutFields: FieldDef[] = [{ name: 'bank', type: 'string', label: 'Bank', required: true }];

interface FetchCall {
  path: string;
  body: Record<string, unknown>;
}

// The server side of the flow: adapted fields can be overridden per endpoint
// to simulate the step engine hiding fields.
function stubServer(overrides: { fieldsFor?: Record<string, FieldDef[]>; invalid?: Record<string, string> } = {}) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const path = new URL(url).pathname;
    calls.push({ path, body });
    if (path === '/api/step/fields') {
      const endpoint = body.endpoint as EndpointDef;
      const fields = overrides.fieldsFor?.[endpoint.id] ?? endpoint.fields;
      return { ok: true, status: 200, json: async () => ({ fields, suggestedValues: {}, degraded: false }) } as Response;
    }
    if (path === '/api/step/validate') {
      const errors = overrides.invalid ?? {};
      const valid = Object.keys(errors).length === 0;
      return { ok: true, status: 200, json: async () => ({ valid, errors, degraded: false }) } as Response;
    }
    if (path === '/api/session/sync') {
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

function threeStepFlow(accountOps: Partial<ResourceOperations> = {}): {
  flow: FlowDef;
  account: ResourceOperations & { create: ReturnType<typeof vi.fn> };
} {
  const account = {
    create: vi.fn().mockResolvedValue({ success: true, resourceId: 'acct_1' }),
    ...accountOps,
  } as ResourceOperations & { create: ReturnType<typeof vi.fn> };
  return {
    account,
    flow: {
      id: 'onboarding',
      title: 'Onboarding',
      description: 'd',
      endpoints: [
        { id: 'account', title: 'Account', fields: accountFields, operations: account },
        { id: 'details', title: 'Details', fields: detailsFields, execute: vi.fn().mockResolvedValue({ success: true }) },
        { id: 'payout', title: 'Payout', fields: payoutFields, execute: vi.fn().mockResolvedValue({ success: true }) },
      ],
    },
  };
}

type Hook = ReturnType<typeof renderHook<ReturnType<typeof useAgentForm>, { flow: FlowDef }>>['result'];

async function fill(result: Hook, values: Record<string, unknown>) {
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => {
    for (const [name, value] of Object.entries(values)) result.current.updateField(name, value);
  });
  await act(() => result.current.submitStep());
  await waitFor(() => expect(result.current.loading).toBe(false));
}

async function completeFirstTwo(result: Hook) {
  await fill(result, { name: 'Jordan', type: 'individual' });
  await fill(result, { detail: 'd1' });
}

function render(flow: FlowDef) {
  return renderHook(({ flow: f }) => useAgentForm(f, { apiUrl: 'http://test.local' }), { initialProps: { flow } }).result;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('goToStep: what read/update allow', () => {
  it('read + update: prefills from the server, saves with update, marks later steps stale and reopens them', async () => {
    stubServer();
    const read = vi.fn().mockResolvedValue({ found: true, data: { name: 'Jordan (server)', type: 'individual' } });
    const update = vi.fn().mockResolvedValue({ success: true });
    const { flow } = threeStepFlow({ read, update });
    const result = render(flow);
    await completeFirstTwo(result);
    expect(result.current.currentStepIndex).toBe(2);

    await act(() => result.current.goToStep('account'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(read).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'acct_1', results: expect.any(Object) }));
    expect(result.current.currentStepIndex).toBe(0);
    expect(result.current.isEditing).toBe(true);
    expect(result.current.editMode).toBe('editable');
    expect(result.current.values).toEqual({ name: 'Jordan (server)', type: 'individual' });

    act(() => result.current.updateField('type', 'business'));
    await act(() => result.current.submitStep());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(update).toHaveBeenCalledWith(
      { name: 'Jordan (server)', type: 'business' },
      expect.objectContaining({ resourceId: 'acct_1', previousValues: { name: 'Jordan', type: 'individual' } })
    );
    expect(result.current.stepRecords.account).toMatchObject({
      status: 'complete',
      values: { name: 'Jordan (server)', type: 'business' },
      result: { success: true, resourceId: 'acct_1' },
    });
    expect(result.current.stepRecords.details.status).not.toBe('complete');
    expect(result.current.isComplete).toBe(false);

    // The first stale step is opened for review, in edit mode, never re-created.
    await waitFor(() => expect(result.current.currentStepIndex).toBe(1));
    expect(result.current.isEditing).toBe(true);
    expect(result.current.editMode).toBe('readOnly'); // `details` only has execute (no update)
  });

  it('read without update: shows the server data read-only and ignores edits', async () => {
    stubServer();
    const read = vi.fn().mockResolvedValue({ found: true, data: { name: 'Jordan', type: 'individual' } });
    const { flow } = threeStepFlow({ read });
    const result = render(flow);
    await completeFirstTwo(result);

    await act(() => result.current.goToStep('account'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.updateField('name', 'Changed'));
    await act(() => result.current.submitStep());

    expect(result.current.editMode).toBe('readOnly');
    expect(result.current.values.name).toBe('Jordan');
    expect(result.current.stepRecords.account.status).toBe('complete');
  });

  it('update without read: prefills from the local record and saves with update', async () => {
    stubServer();
    const update = vi.fn().mockResolvedValue({ success: true });
    const { flow } = threeStepFlow({ update });
    const result = render(flow);
    await completeFirstTwo(result);

    await act(() => result.current.goToStep('account'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.values).toEqual({ name: 'Jordan', type: 'individual' });
    expect(result.current.editMode).toBe('editable');
  });

  it('neither: the step is view-only from the local record', async () => {
    stubServer();
    const { flow } = threeStepFlow();
    const result = render(flow);
    await completeFirstTwo(result);

    await act(() => result.current.goToStep('details'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.editMode).toBe('readOnly');
    expect(result.current.values).toEqual({ detail: 'd1' });
  });

  it('update is unusable when create returned no resourceId', async () => {
    stubServer();
    const { flow } = threeStepFlow({ update: vi.fn() });
    (flow.endpoints[0].operations!.create as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
    const result = render(flow);
    await completeFirstTwo(result);

    await act(() => result.current.goToStep('account'));

    expect(result.current.editMode).toBe('readOnly');
  });
});

describe('goToStep edge cases', () => {
  it('a resource that no longer exists: back to idle (create again), later steps stale', async () => {
    stubServer();
    const read = vi.fn().mockResolvedValue({ found: false });
    const { flow, account } = threeStepFlow({ read, update: vi.fn() });
    const result = render(flow);
    await completeFirstTwo(result);

    await act(() => result.current.goToStep('account'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isEditing).toBe(false);
    expect(result.current.currentStepStatus).toBe('idle');
    expect(result.current.stepRecords.account.result?.resourceId).toBeUndefined();
    expect(result.current.stepRecords.details.status).toBe('stale');
    expect(result.current.values).toEqual({ name: 'Jordan', type: 'individual' });

    await act(() => result.current.submitStep());
    expect(account.create).toHaveBeenCalledTimes(2);
  });

  it('a read that throws leaves the user where they were, with an error', async () => {
    stubServer();
    const read = vi.fn().mockRejectedValue(new Error('network down'));
    const { flow } = threeStepFlow({ read });
    const result = render(flow);
    await completeFirstTwo(result);

    await act(() => result.current.goToStep('account'));

    expect(result.current.currentStepIndex).toBe(2);
    expect(result.current.isEditing).toBe(false);
    expect(result.current.navigationError).toMatch(/Couldn't load "Account": network down/);
  });

  it('only completed (or stale) steps up to the first open one can be revisited', async () => {
    stubServer();
    const { flow } = threeStepFlow();
    const result = render(flow);
    await fill(result, { name: 'Jordan', type: 'individual' });

    expect(result.current.canGoToStep('account')).toBe(true);
    expect(result.current.canGoToStep('details')).toBe(false); // current step
    expect(result.current.canGoToStep('payout')).toBe(false); // not reached yet
    expect(result.current.canGoToStep('nope')).toBe(false);
  });

  it('once the whole flow is complete, every step can be revisited, including the last one', async () => {
    stubServer();
    const { flow } = threeStepFlow();
    const result = render(flow);
    await completeFirstTwo(result);
    await fill(result, { bank: 'First Bank' });

    expect(result.current.isComplete).toBe(true);
    expect(['account', 'details', 'payout'].map((id) => result.current.canGoToStep(id))).toEqual([true, true, true]);
  });

  it('sends the steps before the current one as precedingEndpointIds', async () => {
    const { calls } = stubServer();
    const { flow } = threeStepFlow();
    const result = render(flow);
    await completeFirstTwo(result);

    const fieldCalls = calls.filter((c) => c.path === '/api/step/fields').map((c) => c.body.precedingEndpointIds);
    expect(fieldCalls).toEqual([[], ['account'], ['account', 'details']]);
  });
});

describe('edit-mode submit', () => {
  it('makes no validate/update/sync calls when nothing changed', async () => {
    const { calls } = stubServer();
    const update = vi.fn();
    const { flow } = threeStepFlow({ update });
    const result = render(flow);
    await completeFirstTwo(result);
    await act(() => result.current.goToStep('account'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    calls.length = 0;

    await act(() => result.current.submitStep());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Only the field fetch for the step the wizard returns to -- entering any step does that.
    expect(calls.map((c) => c.path)).toEqual(['/api/step/fields']);
    expect(result.current.currentStepIndex).toBe(2);
    expect(update).not.toHaveBeenCalled();
    expect(result.current.isEditing).toBe(false);
    expect(result.current.stepRecords.details.status).toBe('complete'); // nothing went stale
  });

  it('submits only the visible fields, and treats a now-hidden filled field as a change', async () => {
    // On revisit the step engine only shows `name` (e.g. the earlier answers changed).
    stubServer({ fieldsFor: {} });
    const update = vi.fn().mockResolvedValue({ success: true });
    const { flow } = threeStepFlow({ update });
    const result = render(flow);
    await completeFirstTwo(result);
    stubServer({ fieldsFor: { account: [accountFields[0]] } });

    await act(() => result.current.goToStep('account'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(() => result.current.submitStep());

    expect(update).toHaveBeenCalledWith({ name: 'Jordan' }, expect.objectContaining({ previousValues: { name: 'Jordan', type: 'individual' } }));
  });

  it('a failed update never rolls back: the step stays complete with its old values, and the session is re-synced', async () => {
    const { calls } = stubServer();
    const update = vi.fn().mockResolvedValue({ success: false, message: 'Conflict.' });
    const { flow } = threeStepFlow({ update });
    const result = render(flow);
    await completeFirstTwo(result);
    await act(() => result.current.goToStep('account'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.updateField('name', 'Someone else'));
    await act(() => result.current.submitStep());

    expect(result.current.executionError).toBe('Conflict.');
    expect(result.current.isEditing).toBe(true);
    expect(result.current.stepRecords.account).toMatchObject({ status: 'complete', values: { name: 'Jordan', type: 'individual' } });
    expect(result.current.stepRecords.details.status).toBe('complete');
    const sync = calls.find((c) => c.path === '/api/session/sync');
    expect(sync?.body.steps).toEqual([{ endpointId: 'account', data: { name: 'Jordan', type: 'individual' } }]);
  });

  it('keeps the idempotency key across a failed update retry', async () => {
    stubServer();
    const update = vi
      .fn()
      .mockResolvedValueOnce({ success: false, failure: { kind: 'timeout' } })
      .mockResolvedValueOnce({ success: true });
    const { flow } = threeStepFlow({ update });
    const result = render(flow);
    await completeFirstTwo(result);
    await act(() => result.current.goToStep('account'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.updateField('name', 'New'));
    await act(() => result.current.submitStep());
    await act(() => result.current.submitStep());

    expect(update.mock.calls[0][1].idempotencyKey).toBe(update.mock.calls[1][1].idempotencyKey);
  });
});

describe('cancelEdit', () => {
  it('returns to the step the user was on, restores what they had typed there, and re-syncs the session', async () => {
    const { calls } = stubServer();
    const { flow } = threeStepFlow({ update: vi.fn() });
    const result = render(flow);
    await completeFirstTwo(result);
    act(() => result.current.updateField('bank', 'Half-typed Bank'));

    await act(() => result.current.goToStep('account'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.updateField('name', 'Discarded'));
    act(() => result.current.cancelEdit());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isEditing).toBe(false);
    expect(result.current.currentStepIndex).toBe(2);
    expect(result.current.values).toEqual({ bank: 'Half-typed Bank' });
    expect(result.current.stepRecords.account.values).toEqual({ name: 'Jordan', type: 'individual' });
    expect(calls.find((c) => c.path === '/api/session/sync')?.body.steps).toEqual([
      { endpointId: 'account', data: { name: 'Jordan', type: 'individual' } },
    ]);
  });
});
