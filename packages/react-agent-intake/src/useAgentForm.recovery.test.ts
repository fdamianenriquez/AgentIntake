// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EndpointDef, ExecuteFn, FlowDef, OperationResult } from './contracts.js';
import type { RecoveryEvent } from './recovery.js';
import { useAgentForm, type UseAgentFormOptions } from './useAgentForm.js';

interface Call {
  path: string;
  body: Record<string, any>;
}

type Verdict = { classification: string; explanation: string; rollbackFromEndpointId: string | null } | 'fail';

function stubServer(verdict: Verdict = { classification: 'retryable', explanation: 'x', rollbackFromEndpointId: null }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const path = new URL(url).pathname;
      calls.push({ path, body });
      const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json }) as Response;
      if (path === '/api/step/fields') return ok({ fields: (body.endpoint as EndpointDef).fields, suggestedValues: {}, degraded: false });
      if (path === '/api/step/validate') return ok({ valid: true, errors: {}, degraded: false });
      if (path === '/api/session/sync') return ok({ ok: true });
      if (path === '/api/step/classify-failure') {
        if (verdict === 'fail') return { ok: false, status: 500, json: async () => ({}) } as Response;
        return ok({ ...verdict, degraded: false });
      }
      throw new Error(`unexpected fetch to ${url}`);
    })
  );
  return calls;
}

const field = (name: string) => [{ name, type: 'string' as const, label: name, required: true }];

function makeFlow(payoutCreate: ExecuteFn, withUndo = true) {
  const order: string[] = [];
  const undo = (id: string) => vi.fn(async ({ resourceId }: { resourceId: string }) => {
    order.push(`${id}:${resourceId}`);
    return { success: true } as OperationResult;
  });
  const accountUndo = undo('account');
  const verificationUndo = undo('verification');
  const flow: FlowDef = {
    id: 'onboarding',
    title: 'Onboarding',
    description: 'd',
    endpoints: [
      {
        id: 'account',
        title: 'Account',
        fields: field('name'),
        operations: {
          create: vi.fn().mockResolvedValue({ success: true, resourceId: 'acct_1' }),
          ...(withUndo ? { undo: accountUndo } : {}),
        },
      },
      {
        id: 'verification',
        title: 'Verification',
        fields: field('idNumber'),
        operations: {
          create: vi.fn().mockResolvedValue({ success: true, resourceId: 'ver_1' }),
          ...(withUndo ? { undo: verificationUndo } : {}),
        },
      },
      { id: 'payout', title: 'Payout', fields: field('bank'), operations: { create: payoutCreate } },
    ],
  };
  return { flow, order, accountUndo, verificationUndo };
}

const complianceHold = { success: false, message: 'Account on compliance hold.', failure: { kind: 'http', status: 403, message: 'account on compliance hold' } };

type Hook = ReturnType<typeof renderHook<ReturnType<typeof useAgentForm>, unknown>>;

async function submit(result: Hook['result'], name: string, value: string) {
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.updateField(name, value));
  await act(() => result.current.submitStep());
}

async function failAtPayout(flow: FlowDef, options: Partial<UseAgentFormOptions> = {}) {
  const hook = renderHook(() => useAgentForm(flow, { apiUrl: 'http://test.local', ...options }));
  await submit(hook.result, 'name', 'Jordan');
  await submit(hook.result, 'idNumber', 'ID-1');
  await submit(hook.result, 'bank', 'Hold Bank');
  await waitFor(() => expect(hook.result.current.recovery.phase).not.toBe('classifying'));
  return hook;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('classifying a failed step', () => {
  it('treats a 503 as retryable without asking the model', async () => {
    const calls = stubServer();
    const events: RecoveryEvent[] = [];
    const { flow } = makeFlow(vi.fn().mockResolvedValue({ success: false, failure: { kind: 'http', status: 503 } }));

    const { result } = await failAtPayout(flow, { onRecoveryEvent: (e) => events.push(e) });

    expect(result.current.recovery).toMatchObject({ phase: 'idle', endpointId: 'payout', classification: 'retryable' });
    expect(calls.some((c) => c.path === '/api/step/classify-failure')).toBe(false);
    expect(events).toEqual([{ type: 'classified', endpointId: 'payout', classification: 'retryable', byModel: false }]);
  });

  it('retries an unexplained failure once before asking the model', async () => {
    const calls = stubServer({ classification: 'needs-edit', explanation: 'Check the bank.', rollbackFromEndpointId: null });
    const { flow } = makeFlow(vi.fn().mockResolvedValue({ success: false, message: 'Nope.' }));
    const { result } = await failAtPayout(flow);
    expect(calls.filter((c) => c.path === '/api/step/classify-failure')).toHaveLength(0);

    await act(() => result.current.retryExecution());
    await waitFor(() => expect(result.current.recovery.classification).toBe('needs-edit'));

    expect(calls.filter((c) => c.path === '/api/step/classify-failure')).toHaveLength(1);
  });

  it('asks the model about a 403, sending the definitions of the completed steps', async () => {
    const calls = stubServer({ classification: 'needs-edit', explanation: 'Use a different bank.', rollbackFromEndpointId: null });
    const { flow } = makeFlow(vi.fn().mockResolvedValue(complianceHold));

    const { result } = await failAtPayout(flow);

    const request = calls.find((c) => c.path === '/api/step/classify-failure')!.body;
    expect(request.failure).toEqual({ kind: 'http', status: 403, message: 'account on compliance hold' });
    expect(request.failedEndpoint.id).toBe('payout');
    expect(request.completedEndpoints.map((e: EndpointDef) => e.id)).toEqual(['account', 'verification']);
    expect(request.completedEndpoints[0].fields).toHaveLength(1);
    expect(result.current.recovery).toMatchObject({ phase: 'idle', classification: 'needs-edit', explanation: 'Use a different bank.' });

    act(() => result.current.updateField('bank', 'Other Bank'));
    expect(result.current.recovery.phase).toBe('idle');
    expect(result.current.recovery.classification).toBeUndefined();
  });

  it('falls back to retryable with no proposal when the classification request fails', async () => {
    stubServer('fail');
    const { flow, accountUndo } = makeFlow(vi.fn().mockResolvedValue(complianceHold));

    const { result } = await failAtPayout(flow);

    expect(result.current.recovery).toMatchObject({ phase: 'idle', classification: 'retryable' });
    expect(result.current.recovery.proposedUndo).toBeUndefined();
    expect(accountUndo).not.toHaveBeenCalled();
  });
});

describe('propose -> confirm -> run', () => {
  const fundamental = { classification: 'fundamental', explanation: 'The account is on hold.', rollbackFromEndpointId: 'account' };

  it('proposes undoing from the anchor to the last completed step, in reverse order, and runs nothing yet', async () => {
    stubServer(fundamental);
    const events: RecoveryEvent[] = [];
    const { flow, accountUndo } = makeFlow(vi.fn().mockResolvedValue(complianceHold));

    const { result } = await failAtPayout(flow, { onRecoveryEvent: (e) => events.push(e) });

    expect(result.current.recovery).toMatchObject({
      phase: 'proposed',
      classification: 'fundamental',
      proposedUndo: [
        { endpointId: 'verification', label: 'Verification' },
        { endpointId: 'account', label: 'Account' },
      ],
      skipped: [],
    });
    expect(accountUndo).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['classified', 'proposed']);
  });

  it('on confirm, undoes in reverse order, clears the ids, re-syncs the session and resumes at the anchor', async () => {
    const calls = stubServer(fundamental);
    const events: RecoveryEvent[] = [];
    const { flow, order } = makeFlow(vi.fn().mockResolvedValue(complianceHold));
    const { result } = await failAtPayout(flow, { onRecoveryEvent: (e) => events.push(e) });

    await act(() => result.current.confirmRollback());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(order).toEqual(['verification:ver_1', 'account:acct_1']);
    expect(result.current.recovery).toMatchObject({ phase: 'rolledBack', report: { undone: ['verification', 'account'], skipped: [] } });
    expect(['account', 'verification', 'payout'].map((id) => result.current.stepRecords[id].status)).toEqual(['idle', 'idle', 'idle']);
    expect(result.current.stepRecords.account.result?.resourceId).toBeUndefined();
    expect(result.current.currentStepIndex).toBe(0);
    expect(result.current.values).toEqual({ name: 'Jordan' });
    expect(calls.filter((c) => c.path === '/api/session/sync').map((c) => c.body.steps[0])).toEqual([
      { endpointId: 'verification', data: null },
      { endpointId: 'account', data: null },
      { endpointId: 'payout', data: null },
    ]);
    expect(events.map((e) => e.type)).toEqual(['classified', 'proposed', 'confirmed', 'undone', 'undone']);
  });

  it('stops at the first failed undo, and retryRollback resumes from it', async () => {
    stubServer(fundamental);
    const { flow, order, accountUndo } = makeFlow(vi.fn().mockResolvedValue(complianceHold));
    (flow.endpoints[1].operations!.undo as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: false, message: 'Locked.', failure: { kind: 'http', status: 423 } })
      .mockImplementationOnce(async ({ resourceId }: { resourceId: string }) => {
        order.push(`verification:${resourceId}`);
        return { success: true };
      });
    const { result } = await failAtPayout(flow);

    await act(() => result.current.confirmRollback());

    expect(result.current.recovery).toMatchObject({
      phase: 'rollbackFailed',
      report: { undone: [], failed: { endpointId: 'verification', message: 'Locked.' } },
    });
    expect(accountUndo).not.toHaveBeenCalled();
    expect(result.current.stepRecords.account.status).toBe('complete');

    await act(() => result.current.retryRollback());

    expect(order).toEqual(['verification:ver_1', 'account:acct_1']);
    expect(result.current.recovery.phase).toBe('rolledBack');
  });

  it('decline keeps everything, and the user can still retry', async () => {
    stubServer(fundamental);
    const { flow, accountUndo } = makeFlow(vi.fn().mockResolvedValueOnce(complianceHold).mockResolvedValueOnce({ success: true }));
    const { result } = await failAtPayout(flow);

    act(() => result.current.declineRollback());

    expect(result.current.recovery).toMatchObject({ phase: 'idle', classification: 'fundamental' });
    expect(result.current.recovery.proposedUndo).toBeUndefined();
    await act(() => result.current.retryExecution());
    expect(result.current.isComplete).toBe(true);
    expect(accountUndo).not.toHaveBeenCalled();
  });

  it("never proposes with recovery.rollback: 'off'", async () => {
    stubServer(fundamental);
    const { flow } = makeFlow(vi.fn().mockResolvedValue(complianceHold));

    const { result } = await failAtPayout(flow, { recovery: { rollback: 'off' } });

    expect(result.current.recovery).toMatchObject({ phase: 'idle', classification: 'fundamental' });
    expect(result.current.recovery.proposedUndo).toBeUndefined();
  });

  it('says manual cleanup is needed when nothing in range can be undone', async () => {
    stubServer(fundamental);
    const { flow } = makeFlow(vi.fn().mockResolvedValue(complianceHold), false);

    const { result } = await failAtPayout(flow);

    expect(result.current.recovery.phase).toBe('idle');
    expect(result.current.recovery.explanation).toMatch(/needs manual cleanup/);
  });

  it('runs each undo once even if confirm is clicked twice', async () => {
    stubServer(fundamental);
    const { flow, accountUndo, verificationUndo } = makeFlow(vi.fn().mockResolvedValue(complianceHold));
    const { result } = await failAtPayout(flow);

    await act(async () => {
      await Promise.all([result.current.confirmRollback(), result.current.confirmRollback()]);
    });

    expect(verificationUndo).toHaveBeenCalledTimes(1);
    expect(accountUndo).toHaveBeenCalledTimes(1);
  });

  it('lets an in-flight undo finish after unmount, but runs nothing after it', async () => {
    stubServer(fundamental);
    const { flow, accountUndo } = makeFlow(vi.fn().mockResolvedValue(complianceHold));
    let finishVerification!: () => void;
    (flow.endpoints[1].operations!.undo as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<OperationResult>((resolve) => (finishVerification = () => resolve({ success: true })))
    );
    const { result, unmount } = await failAtPayout(flow);

    let rollback!: Promise<void>;
    act(() => {
      rollback = result.current.confirmRollback();
    });
    unmount();
    finishVerification();
    await rollback;

    expect(accountUndo).not.toHaveBeenCalled();
  });
});

describe('no navigation or submits while a rollback is pending, running or failed', () => {
  const fundamental = { classification: 'fundamental', explanation: 'On hold.', rollbackFromEndpointId: 'account' };
  const ids = ['account', 'verification', 'payout'];

  function expectLocked(result: Hook['result']) {
    expect(ids.map((id) => result.current.canGoToStep(id))).toEqual([false, false, false]);
  }

  it('while a proposal is pending', async () => {
    stubServer(fundamental);
    const payoutCreate = vi.fn().mockResolvedValue(complianceHold);
    const { flow } = makeFlow(payoutCreate);
    const { result } = await failAtPayout(flow);
    expect(result.current.recovery.phase).toBe('proposed');

    expectLocked(result);
    await act(() => result.current.submitStep());
    await act(() => result.current.retryExecution());
    await act(() => result.current.goToStep('account'));

    expect(payoutCreate).toHaveBeenCalledTimes(1);
    expect(result.current.currentStepIndex).toBe(2);
  });

  it('while the undo is running', async () => {
    stubServer(fundamental);
    const payoutCreate = vi.fn().mockResolvedValue(complianceHold);
    const { flow } = makeFlow(payoutCreate);
    let finish!: () => void;
    (flow.endpoints[1].operations!.undo as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<OperationResult>((resolve) => (finish = () => resolve({ success: true })))
    );
    const { result } = await failAtPayout(flow);

    let rollback!: Promise<void>;
    act(() => {
      rollback = result.current.confirmRollback();
    });
    await waitFor(() => expect(result.current.recovery.phase).toBe('rollingBack'));

    expectLocked(result);
    await act(() => result.current.submitStep());
    expect(payoutCreate).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish();
      await rollback;
    });
  });

  it('after an undo failed, until it is retried', async () => {
    stubServer(fundamental);
    const payoutCreate = vi.fn().mockResolvedValue(complianceHold);
    const { flow } = makeFlow(payoutCreate);
    (flow.endpoints[1].operations!.undo as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false, message: 'Locked.' });
    const { result } = await failAtPayout(flow);
    await act(() => result.current.confirmRollback());
    expect(result.current.recovery.phase).toBe('rollbackFailed');

    expectLocked(result);
    await act(() => result.current.submitStep());
    await act(() => result.current.retryExecution());
    expect(payoutCreate).toHaveBeenCalledTimes(1);
  });

  it('everything works again after the proposal is declined', async () => {
    stubServer(fundamental);
    const { flow } = makeFlow(vi.fn().mockResolvedValue(complianceHold));
    const { result } = await failAtPayout(flow);

    act(() => result.current.declineRollback());

    expect(result.current.canGoToStep('account')).toBe(true);
    await act(() => result.current.goToStep('account'));
    expect(result.current.currentStepIndex).toBe(0);
  });
});

describe('steps a rollback could not undo', () => {
  const fundamental = { classification: 'fundamental', explanation: 'On hold.', rollbackFromEndpointId: 'account' };

  it('are marked stale (not left complete), keep their values, and are reviewed after the anchor is redone', async () => {
    stubServer(fundamental);
    const { flow, accountUndo } = makeFlow(vi.fn().mockResolvedValue(complianceHold));
    delete (flow.endpoints[1].operations as { undo?: unknown }).undo; // verification can't be undone
    const { result } = await failAtPayout(flow);
    expect(result.current.recovery).toMatchObject({
      proposedUndo: [{ endpointId: 'account', label: 'Account' }],
      skipped: ['verification'],
    });

    await act(() => result.current.confirmRollback());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(accountUndo).toHaveBeenCalledTimes(1);
    expect(result.current.stepRecords.verification).toMatchObject({
      status: 'stale',
      staleReason: 'A step it depends on was undone and this one could not be undone automatically.',
      values: { idNumber: 'ID-1' },
      result: { success: true, resourceId: 'ver_1' },
    });
    expect(result.current.recovery.report?.skipped).toEqual(['verification']);
    expect(result.current.isComplete).toBe(false);
    expect(result.current.currentStepIndex).toBe(0);

    // Redoing the anchor routes to the stale step for review, never re-creating it.
    await act(() => result.current.submitStep());
    await waitFor(() => expect(result.current.currentStepIndex).toBe(1));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isEditing).toBe(true);
    expect(result.current.currentStepStatus).toBe('stale');
    expect(flow.endpoints[1].operations!.create).toHaveBeenCalledTimes(1);
  });
});
