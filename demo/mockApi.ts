// An in-memory stand-in for the payment onboarding API described in
// server/specs/example-payment-onboarding.openapi.yaml. It runs in the
// browser, answers with real HTTP Responses (so failureFromResponse works on
// them exactly as on a real API), and can inject the failures the demo's
// scenarios need. Nothing here is AgentIntake itself; it plays the role of the
// flow author's own backend.

export type Scenario = 'normal' | 'payout-timeout' | 'compliance-hold';

type Data = Record<string, unknown>;

export interface MockApiCall {
  method: string;
  path: string;
  status: number | 'timeout';
}

const LATENCY_MS = 350;
const TIMEOUT_MS = 1500;

function respond(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function createMockApi(onCall: (call: MockApiCall) => void) {
  let scenario: Scenario = 'normal';
  let timeoutsLeft = 0;
  let sequence = 0;
  const accounts = new Map<string, Data>();
  const verifications = new Map<string, Data & { accountId: string }>();
  const payoutMethods = new Map<string, Data & { accountId: string }>();
  const payoutsByIdempotencyKey = new Map<string, string>();

  const nextId = (prefix: string) => `${prefix}_${++sequence}`;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function handle(method: string, path: string, run: () => Response): Promise<Response> {
    await wait(LATENCY_MS);
    const response = run();
    onCall({ method, path, status: response.status });
    return response;
  }

  return {
    /** Applies to the next payout attempt(s). */
    setScenario(next: Scenario) {
      scenario = next;
      timeoutsLeft = next === 'payout-timeout' ? 1 : 0;
    },

    createAccount: (data: Data) =>
      handle('POST', '/accounts', () => {
        const id = nextId('acct');
        accounts.set(id, data);
        return respond(201, { id, ...data });
      }),
    getAccount: (id: string) =>
      handle('GET', `/accounts/${id}`, () => (accounts.has(id) ? respond(200, accounts.get(id)) : respond(404, { error: 'No such account.' }))),
    updateAccount: (id: string, data: Data) =>
      handle('PATCH', `/accounts/${id}`, () => {
        if (!accounts.has(id)) return respond(404, { error: 'No such account.' });
        accounts.set(id, { ...accounts.get(id), ...data });
        return respond(200, { id, ...accounts.get(id) });
      }),
    deleteAccount: (id: string) =>
      handle('DELETE', `/accounts/${id}`, () => (accounts.delete(id) ? respond(204) : respond(404, { error: 'No such account.' }))),

    createVerification: (accountId: string, data: Data) =>
      handle('POST', `/accounts/${accountId}/verifications`, () => {
        if (!accounts.has(accountId)) return respond(404, { error: 'No such account.' });
        const id = nextId('ver');
        verifications.set(id, { ...data, accountId });
        return respond(201, { id, ...data });
      }),
    getVerification: (accountId: string, id: string) =>
      handle('GET', `/accounts/${accountId}/verifications/${id}`, () => {
        const record = verifications.get(id);
        if (!record || record.accountId !== accountId) return respond(404, { error: 'No such verification.' });
        const { accountId: _owner, ...data } = record;
        return respond(200, data);
      }),
    updateVerification: (accountId: string, id: string, data: Data) =>
      handle('PATCH', `/accounts/${accountId}/verifications/${id}`, () => {
        const record = verifications.get(id);
        if (!record || record.accountId !== accountId) return respond(404, { error: 'No such verification.' });
        verifications.set(id, { ...record, ...data });
        return respond(200, { id });
      }),
    deleteVerification: (accountId: string, id: string) =>
      handle('DELETE', `/accounts/${accountId}/verifications/${id}`, () =>
        verifications.delete(id) ? respond(204) : respond(404, { error: 'No such verification.' })
      ),

    async createPayoutMethod(accountId: string, data: Data, idempotencyKey: string): Promise<Response> {
      const path = `/accounts/${accountId}/payout-methods`;
      if (timeoutsLeft > 0) {
        timeoutsLeft--;
        await wait(TIMEOUT_MS);
        onCall({ method: 'POST', path, status: 'timeout' });
        throw new DOMException('The request timed out.', 'TimeoutError');
      }
      return handle('POST', path, () => {
        if (!accounts.has(accountId)) return respond(404, { error: 'No such account.' });
        if (scenario === 'compliance-hold') {
          return respond(403, { error: 'account on compliance hold: payouts are disabled for this account' });
        }
        // The idempotency key makes a retry after a timeout safe: same key, same payout method.
        const existing = payoutsByIdempotencyKey.get(idempotencyKey);
        if (existing) return respond(201, { id: existing, ...payoutMethods.get(existing) });
        const id = nextId('pm');
        payoutMethods.set(id, { ...data, accountId });
        payoutsByIdempotencyKey.set(idempotencyKey, id);
        return respond(201, { id, ...data });
      });
    },
    deletePayoutMethod: (accountId: string, id: string) =>
      handle('DELETE', `/accounts/${accountId}/payout-methods/${id}`, () =>
        payoutMethods.delete(id) ? respond(204) : respond(404, { error: 'No such payout method.' })
      ),
  };
}

export type MockApi = ReturnType<typeof createMockApi>;
