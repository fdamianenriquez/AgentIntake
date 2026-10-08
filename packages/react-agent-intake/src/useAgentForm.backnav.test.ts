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
function stubServer(
  overrides: {
    fieldsFor?: Record<string, FieldDef[]>;
    invalid?: Record<string, string>;
    /** Which later steps the invalidation check flags; default: all of them. 'fail' makes the request fail. */
    affected?: string[] | 'fail';
  } = {}
) {
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
    if (path === '/api/step/check-invalidation') {
      if (overrides.affected === 'fail') return { ok: false, status: 500, json: async () => ({}) } as Response;
      const later = (body.laterCompletedEndpoints as EndpointDef[]).map((endpoint) => endpoint.id);
      const ids = overrides.affected ?? later;
      const affected = ids.map((endpointId) => ({ endpointId, reason: `Because of the change (${endpointId}).` }));
      return { ok: true, status: 200, json: async () => ({ affected, degraded: false }) } as Response;
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

describe('cross-step invalidation', () => {
  async function editAccountType(result: Hook) {
    await act(() => result.current.goToStep('account'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.updateField('type', 'business'));
    await act(() => result.current.submitStep());
    await waitFor(() => expect(result.current.loading).toBe(false));
  }

  it('asks the server about the later completed steps, sending their definitions, and flags only those it names', async () => {
    const { calls } = stubServer({ affected: ['payout'] });
    const { flow } = threeStepFlow({ update: vi.fn().mockResolvedValue({ success: true }) });
    const result = render(flow);
    await completeFirstTwo(result);
    await fill(result, { bank: 'First Bank' });

    await editAccountType(result);

    const check = calls.find((c) => c.path === '/api/step/check-invalidation');
    expect(check?.body).toMatchObject({
      before: { name: 'Jordan', type: 'individual' },
      after: { name: 'Jordan', type: 'business' },
    });
    expect((check?.body.laterCompletedEndpoints as EndpointDef[]).map((e) => [e.id, e.fields.length])).toEqual([
      ['details', 1],
      ['payout', 1],
    ]);
    expect(result.current.stepRecords.details.status).toBe('complete');
    expect(result.current.stepRecords.payout).toMatchObject({ status: 'stale', staleReason: 'Because of the change (payout).' });
  });

  it('flags every later completed step when the check itself fails (safe side)', async () => {
    stubServer({ affected: 'fail' });
    const { flow } = threeStepFlow({ update: vi.fn().mockResolvedValue({ success: true }) });
    const result = render(flow);
    await completeFirstTwo(result);
    await fill(result, { bank: 'First Bank' });

    await editAccountType(result);

    expect(['details', 'payout'].map((id) => result.current.stepRecords[id].status)).toEqual(['stale', 'stale']);
    expect(result.current.stepRecords.details.staleReason).toMatch(/earlier answer changed/);
  });

  it('ignores ids it did not ask about', async () => {
    stubServer({ affected: ['account', 'nope'] });
    const { flow } = threeStepFlow({ update: vi.fn().mockResolvedValue({ success: true }) });
    const result = render(flow);
    await completeFirstTwo(result);

    await editAccountType(result);

    expect(result.current.stepRecords.account.status).toBe('complete');
    expect(result.current.stepRecords.details.status).toBe('complete');
    expect(result.current.isComplete).toBe(false); // payout was never done
  });

  it('makes no check when no later step is complete', async () => {
    const { calls } = stubServer();
    const { flow } = threeStepFlow({ update: vi.fn().mockResolvedValue({ success: true }) });
    const result = render(flow);
    await fill(result, { name: 'Jordan', type: 'individual' });

    await editAccountType(result);

    expect(calls.some((c) => c.path === '/api/step/check-invalidation')).toBe(false);
  });
});

describe('resolving a stale step', () => {
  function flowWithEditableDetails(detailsUpdate?: ResourceOperations['update']) {
    const { flow } = threeStepFlow({ update: vi.fn().mockResolvedValue({ success: true }) });
    flow.endpoints[1] = {
      id: 'details',
      title: 'Details',
      fields: detailsFields,
      operations: {
        create: vi.fn().mockResolvedValue({ success: true, resourceId: 'det_1' }),
        ...(detailsUpdate ? { update: detailsUpdate } : {}),
      },
    };
    return flow;
  }

  async function makeDetailsStale(result: Hook) {
    await act(() => result.current.goToStep('account'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.updateField('type', 'business'));
    await act(() => result.current.submitStep());
    await waitFor(() => expect(result.current.currentStepIndex).toBe(1));
    await waitFor(() => expect(result.current.loading).toBe(false));
  }

  it('keeps a stale step as it is when its fields did not change', async () => {
    stubServer({ affected: ['details'] });
    const result = render(flowWithEditableDetails(vi.fn()));
    await completeFirstTwo(result);
    await makeDetailsStale(result);

    expect(result.current.staleResolution).toBe('keepOrEdit');
    let outcome!: ReturnType<typeof result.current.acknowledgeStale>;
    act(() => {
      outcome = result.current.acknowledgeStale();
    });

    expect(outcome).toEqual({ ok: true });
    expect(result.current.stepRecords.details).toMatchObject({ status: 'complete', staleReason: undefined });
  });

  it('refuses to keep a stale step whose fields changed; it has to be saved again', async () => {
    stubServer({ affected: ['details'] });
    const detailsUpdate = vi.fn().mockResolvedValue({ success: true });
    const result = render(flowWithEditableDetails(detailsUpdate));
    await completeFirstTwo(result);
    const businessDetails: FieldDef[] = [{ name: 'registration', type: 'string', label: 'Registration', required: true }];
    stubServer({ affected: ['details'], fieldsFor: { details: businessDetails } });
    await makeDetailsStale(result);

    expect(result.current.staleResolution).toBe('mustEdit');
    let outcome!: ReturnType<typeof result.current.acknowledgeStale>;
    act(() => {
      outcome = result.current.acknowledgeStale();
    });
    expect(outcome).toEqual({ ok: false, reason: 'fieldsChanged' });

    act(() => result.current.updateField('registration', 'R-123'));
    await act(() => result.current.submitStep());
    expect(detailsUpdate).toHaveBeenCalledWith({ registration: 'R-123' }, expect.objectContaining({ previousValues: { detail: 'd1' } }));
    expect(result.current.stepRecords.details).toMatchObject({ status: 'complete', fieldNames: ['registration'] });
  });

  it('a stale step that cannot be changed and whose fields changed is accepted with a follow-up note', async () => {
    stubServer({ affected: ['details'] });
    const result = render(flowWithEditableDetails());
    await completeFirstTwo(result);
    stubServer({ affected: ['details'], fieldsFor: { details: [{ name: 'registration', type: 'string', label: 'Registration', required: true }] } });
    await makeDetailsStale(result);

    expect(result.current.editMode).toBe('readOnly');
    expect(result.current.staleResolution).toBe('followUp');
    act(() => result.current.flagForFollowUp());

    expect(result.current.stepRecords.details.status).toBe('complete');
    expect(result.current.followUps).toEqual([
      { endpointId: 'details', note: expect.stringContaining("can't be changed in this wizard") },
    ]);
  });
});

describe('the gap between saving an edit and opening the step to review', () => {
  it('blocks submitting the edited step again while the next step is being opened', async () => {
    stubServer({ affected: ['details'] });
    let finishRead!: () => void;
    const detailsRead = vi.fn(
      () => new Promise<{ found: true; data: Record<string, unknown> }>((resolve) => (finishRead = () => resolve({ found: true, data: { detail: 'd1' } })))
    );
    const { flow, account } = threeStepFlow({ update: vi.fn().mockResolvedValue({ success: true }) });
    flow.endpoints[1] = {
      id: 'details',
      title: 'Details',
      fields: detailsFields,
      operations: { create: vi.fn().mockResolvedValue({ success: true, resourceId: 'det_1' }), read: detailsRead },
    };
    const result = render(flow);
    await completeFirstTwo(result);
    await act(() => result.current.goToStep('account'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.updateField('type', 'business'));
    await act(() => result.current.submitStep());
    await waitFor(() => expect(detailsRead).toHaveBeenCalled());

    // The account step is still on screen, no longer in edit mode -- the trap.
    expect(result.current.navigating).toBe(true);
    await act(() => result.current.submitStep());
    expect(account.create).toHaveBeenCalledTimes(1);

    await act(async () => finishRead());
    await waitFor(() => expect(result.current.currentStepIndex).toBe(1));
    expect(result.current.navigating).toBe(false);
  });
});

describe('cancelling a review that opened automatically after an edit', () => {
  async function editAccountAndLandOnReview(result: Hook) {
    await act(() => result.current.goToStep('account'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.updateField('type', 'business'));
    await act(() => result.current.submitStep());
    await waitFor(() => expect(result.current.currentStepIndex).toBe(1));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isEditing).toBe(true);
  }

  it('returns to where the user was before starting the edit, not to the edited step', async () => {
    stubServer({ affected: ['details'] });
    const { flow, account } = threeStepFlow({ update: vi.fn().mockResolvedValue({ success: true }) });
    const result = render(flow);
    await completeFirstTwo(result); // now on payout, not yet done
    await editAccountAndLandOnReview(result);

    act(() => result.current.cancelEdit());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.currentStepIndex).toBe(2);
    expect(result.current.isEditing).toBe(false);
    expect(result.current.stepRecords.account.status).toBe('complete');
    expect(account.create).toHaveBeenCalledTimes(1);
  });

  it('never leaves a completed step on screen outside edit mode, and submitting one never re-creates it', async () => {
    stubServer({ affected: ['details'] });
    const { flow, account } = threeStepFlow({ update: vi.fn().mockResolvedValue({ success: true }) });
    const result = render(flow);
    await completeFirstTwo(result);
    await fill(result, { bank: 'First Bank' }); // everything complete; the user is "on" the last step
    await editAccountAndLandOnReview(result);

    act(() => result.current.cancelEdit());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // The only step needing the user is the stale one, so it is reopened for review.
    await waitFor(() => expect(result.current.isEditing).toBe(true));
    expect(result.current.currentStepIndex).toBe(1);

    // And at the hook level: a completed step outside edit mode is never created again.
    act(() => result.current.cancelEdit());
    await act(() => result.current.submitStep());
    expect(account.create).toHaveBeenCalledTimes(1);
    expect(result.current.stepRecords.account.status).toBe('complete');
  });
});
