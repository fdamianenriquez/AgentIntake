import { useMemo, useState } from 'react';
import { AgentIntakeForm, failureFromResponse, undoResultFromResponse } from '../packages/react-agent-intake/src/index.js';
import {
  GeneratedFlowSchema,
  type FlowDef,
  type OperationResult,
  type ResourceOperations,
} from '../packages/react-agent-intake/src/contracts.js';
import { createMockApi, type MockApi, type MockApiCall, type Scenario } from './mockApi.js';
import rawFlow from './flow.json' with { type: 'json' };

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

// Validated (not just cast) so a hand-edited flow.json that drifted from the
// schema fails loudly here rather than producing subtly-wrong form controls
// -- also gives properly-typed fields, which a raw JSON import loses (its
// `type` fields infer as plain `string`, not the FieldDef literal union).
const generatedFlow = GeneratedFlowSchema.parse(rawFlow);

// Maps one HTTP call to an OperationResult -- the part every flow author
// writes for their own API (AgentIntake never calls it or reads its responses).
async function call(request: () => Promise<Response>): Promise<OperationResult> {
  try {
    const response = await request();
    if (!response.ok) {
      return { success: false, message: `The service answered ${response.status}.`, failure: await failureFromResponse(response) };
    }
    const body = response.status === 204 ? {} : await response.json();
    return { success: true, resourceId: body.id, output: body };
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    return {
      success: false,
      message: timedOut ? 'The service took too long to answer.' : String(error),
      failure: { kind: timedOut ? 'timeout' : 'network' },
    };
  }
}

// Undo counts "already gone" as done (see undoResultFromResponse).
async function undo(request: () => Promise<Response>): Promise<OperationResult> {
  try {
    return await undoResultFromResponse(await request());
  } catch (error) {
    return { success: false, message: String(error), failure: { kind: 'network' } };
  }
}

async function read(request: () => Promise<Response>) {
  const response = await request();
  if (response.status === 404) return { found: false as const };
  if (!response.ok) throw new Error(`The service answered ${response.status}.`);
  return { found: true as const, data: await response.json() };
}

// The flow author's own operations, written against the (mock) API. flow.json
// lists what the spec offers per step (capabilities, path parameters); these
// implement it. Later steps get the account id from ctx.results.
function operationsFor(api: MockApi): Record<string, ResourceOperations> {
  const accountIdOf = (results: Record<string, OperationResult>) => results.createAccount?.resourceId ?? '';
  return {
    createAccount: {
      create: (data) => call(() => api.createAccount(data)),
      read: ({ resourceId }) => read(() => api.getAccount(resourceId)),
      update: (data, { resourceId }) => call(() => api.updateAccount(resourceId, data)),
      undo: ({ resourceId }) => undo(() => api.deleteAccount(resourceId)),
    },
    createVerification: {
      create: (data, { results }) => call(() => api.createVerification(accountIdOf(results), data)),
      read: ({ resourceId, results }) => read(() => api.getVerification(accountIdOf(results), resourceId)),
      update: (data, { resourceId, results }) => call(() => api.updateVerification(accountIdOf(results), resourceId, data)),
      undo: ({ resourceId, results }) => undo(() => api.deleteVerification(accountIdOf(results), resourceId)),
    },
    createPayoutMethod: {
      create: (data, { results, idempotencyKey }) =>
        call(() => api.createPayoutMethod(accountIdOf(results), data, idempotencyKey)),
      undo: ({ resourceId, results }) => undo(() => api.deletePayoutMethod(accountIdOf(results), resourceId)),
    },
  };
}

const SCENARIOS: { value: Scenario; label: string; hint: string }[] = [
  { value: 'normal', label: 'Everything works', hint: 'Try going back to the first step and switching the account type.' },
  { value: 'payout-timeout', label: 'Payout request times out once', hint: 'A timeout is retried without asking the model.' },
  {
    value: 'compliance-hold',
    label: 'Account is on compliance hold',
    hint: 'Adding a payout method fails with a 403; the form proposes undoing the earlier steps.',
  },
];

export function App() {
  const [calls, setCalls] = useState<MockApiCall[]>([]);
  const [scenario, setScenario] = useState<Scenario>('normal');
  const api = useMemo(() => createMockApi((entry) => setCalls((previous) => [...previous, entry])), []);

  const flow: FlowDef = useMemo(() => {
    const operations = operationsFor(api);
    return {
      ...generatedFlow,
      endpoints: generatedFlow.endpoints.map((endpoint) => ({ ...endpoint, operations: operations[endpoint.id] })),
    };
  }, [api]);

  const chooseScenario = (next: Scenario) => {
    setScenario(next);
    api.setScenario(next);
  };

  return (
    <main className="demo-app">
      <h1>{flow.title}</h1>
      <p>{flow.description}</p>
      <p className="demo-app-note">
        Adaptive fields, semantic checks, change review and failure classification come from a real,
        locally running AgentIntake server. Each step's operations call an in-browser mock of the payment
        API instead of a real one. Field names are deliberately generic and fictional -- this demonstrates
        the mechanism, not real KYC/KYB compliance requirements for any jurisdiction.
      </p>

      <fieldset className="demo-scenarios">
        <legend>Simulate</legend>
        {SCENARIOS.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name="scenario"
              value={option.value}
              checked={scenario === option.value}
              onChange={() => chooseScenario(option.value)}
            />
            {option.label}
          </label>
        ))}
        <p className="demo-app-note">{SCENARIOS.find((option) => option.value === scenario)?.hint}</p>
      </fieldset>

      <AgentIntakeForm flow={flow} apiUrl={API_URL} />

      <details className="demo-api-log" open={calls.length > 0}>
        <summary>Mock API calls ({calls.length})</summary>
        <ol>
          {calls.map((entry, index) => (
            <li key={index}>
              <code>
                {entry.method} {entry.path}
              </code>{' '}
              → {entry.status}
            </li>
          ))}
        </ol>
      </details>
    </main>
  );
}
