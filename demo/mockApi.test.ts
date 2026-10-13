import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi, type MockApiCall } from './mockApi.js';

let calls: MockApiCall[];

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
});

afterEach(() => {
  vi.useRealTimers();
});

async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

describe('demo mock API', () => {
  it('creates, reads, updates and deletes an account', async () => {
    const api = createMockApi((c) => calls.push(c));
    const { id } = await (await settle(api.createAccount({ fullName: 'Jordan' }))).json();

    expect(await (await settle(api.getAccount(id))).json()).toEqual({ id, fullName: 'Jordan' });
    await settle(api.updateAccount(id, { accountType: 'business' }));
    expect(await (await settle(api.getAccount(id))).json()).toEqual({ id, fullName: 'Jordan', accountType: 'business' });
    expect((await settle(api.deleteAccount(id))).status).toBe(204);
    expect((await settle(api.getAccount(id))).status).toBe(404);
  });

  it('scenario A: the timed-out attempt did create the payout method; a retry with the same key returns it', async () => {
    const api = createMockApi((c) => calls.push(c));
    const { id: accountId } = await (await settle(api.createAccount({}))).json();
    api.setScenario('payout-timeout');

    const first = api.createPayoutMethod(accountId, { bankName: 'B' }, 'key-1');
    const rejection = expect(first).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.runAllTimersAsync();
    await rejection;
    expect(api.payoutMethodCount()).toBe(1); // created, but the client never saw the response

    const retry = await settle(api.createPayoutMethod(accountId, { bankName: 'B' }, 'key-1'));
    const { id } = await retry.json();
    expect(api.payoutMethodCount()).toBe(1);
    expect(calls.slice(1)).toEqual([
      { method: 'POST', path: `/accounts/${accountId}/payout-methods`, status: 'timeout' },
      { method: 'POST', path: `/accounts/${accountId}/payout-methods`, status: 201 },
    ]);

    // The key is what prevents the duplicate: a different key creates a second one.
    const other = await (await settle(api.createPayoutMethod(accountId, { bankName: 'B' }, 'key-2'))).json();
    expect(other.id).not.toBe(id);
    expect(api.payoutMethodCount()).toBe(2);
  });

  it('only deletes a verification through the account it belongs to', async () => {
    const api = createMockApi((c) => calls.push(c));
    const { id: accountId } = await (await settle(api.createAccount({}))).json();
    const { id } = await (await settle(api.createVerification(accountId, {}))).json();

    expect((await settle(api.deleteVerification('acct_other', id))).status).toBe(404);
    expect((await settle(api.deleteVerification(accountId, id))).status).toBe(204);
  });

  it('scenario B: adding a payout method fails with a 403 compliance hold', async () => {
    const api = createMockApi((c) => calls.push(c));
    const { id: accountId } = await (await settle(api.createAccount({}))).json();
    api.setScenario('compliance-hold');

    const response = await settle(api.createPayoutMethod(accountId, { bankName: 'B' }, 'key-2'));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: expect.stringContaining('compliance hold') });
  });

  it('keeps verifications under their account', async () => {
    const api = createMockApi((c) => calls.push(c));
    const { id: accountId } = await (await settle(api.createAccount({}))).json();
    const { id } = await (await settle(api.createVerification(accountId, { dateOfBirth: '1990-01-01' }))).json();

    expect((await settle(api.getVerification('acct_other', id))).status).toBe(404);
    expect(await (await settle(api.getVerification(accountId, id))).json()).toEqual({ id, dateOfBirth: '1990-01-01' });
  });
});
