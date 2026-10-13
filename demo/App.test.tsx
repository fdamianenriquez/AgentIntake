// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EndpointDef, FlowDef } from '../packages/react-agent-intake/src/contracts.js';
import { useAgentForm } from '../packages/react-agent-intake/src/useAgentForm.js';
import { operationsFor } from './App.js';
import { createMockApi, type MockApiCall } from './mockApi.js';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const path = new URL(url).pathname;
      const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json }) as Response;
      if (path === '/api/step/fields') return ok({ fields: (body.endpoint as EndpointDef).fields, suggestedValues: {}, degraded: false });
      if (path === '/api/step/validate') return ok({ valid: true, errors: {}, degraded: false });
      if (path === '/api/session/sync') return ok({ ok: true });
      if (path === '/api/step/classify-failure') {
        return ok({ classification: 'fundamental', explanation: 'On hold.', rollbackFromEndpointId: 'account', degraded: false });
      }
      throw new Error(`unexpected fetch to ${url}`);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('demo operations', () => {
  it('refuse to build a request without an account id', async () => {
    const calls: MockApiCall[] = [];
    const ops = operationsFor(createMockApi((call) => calls.push(call)));

    await expect(ops.createVerification.undo!({ results: {}, idempotencyKey: 'k', resourceId: 'ver_1' })).rejects.toThrow(
      /account id/
    );
    expect(calls).toEqual([]);
  });

  it('an undo without an account id is reported as failed, not undone', async () => {
    const calls: MockApiCall[] = [];
    const demo = operationsFor(createMockApi((call) => calls.push(call)));
    const field = (name: string) => [{ name, type: 'string' as const, label: name, required: true }];
    // No step is called createAccount, so ctx.results never holds an account id.
    const flow: FlowDef = {
      id: 'demo-ops',
      title: 'Demo operations',
      description: 'd',
      endpoints: [
        {
          id: 'account',
          title: 'Account',
          fields: field('name'),
          operations: { create: vi.fn().mockResolvedValue({ success: true, resourceId: 'acct_1' }), undo: vi.fn().mockResolvedValue({ success: true }) },
        },
        {
          id: 'verification',
          title: 'Verification',
          fields: field('idNumber'),
          operations: { create: vi.fn().mockResolvedValue({ success: true, resourceId: 'ver_1' }), undo: demo.createVerification.undo },
        },
        {
          id: 'payout',
          title: 'Payout',
          fields: field('bank'),
          operations: { create: vi.fn().mockResolvedValue({ success: false, failure: { kind: 'http', status: 403 } }) },
        },
      ],
    };
    const { result } = renderHook(() => useAgentForm(flow, { apiUrl: 'http://test.local' }));
    for (const [name, value] of [['name', 'Jordan'], ['idNumber', 'ID-1'], ['bank', 'Bank']]) {
      await waitFor(() => expect(result.current.loading).toBe(false));
      act(() => result.current.updateField(name, value));
      await act(() => result.current.submitStep());
    }
    await waitFor(() => expect(result.current.recovery.phase).toBe('proposed'));

    await act(() => result.current.confirmRollback());

    expect(result.current.recovery.phase).toBe('rollbackFailed');
    expect(result.current.recovery.report?.failed?.endpointId).toBe('verification');
    expect(result.current.stepRecords.verification.result?.resourceId).toBe('ver_1');
    expect(calls).toEqual([]);
  });
});
