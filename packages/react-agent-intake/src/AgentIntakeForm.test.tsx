// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FieldDef, FlowDef, ResourceOperations } from './contracts.js';
import { AgentIntakeForm } from './AgentIntakeForm.js';

function stubFetch() {
  return vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (url.endsWith('/api/step/fields')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ fields: body.endpoint.fields, suggestedValues: {}, degraded: false }),
      } as Response;
    }
    if (url.endsWith('/api/step/validate')) {
      return { ok: true, status: 200, json: async () => ({ valid: true, errors: {}, degraded: false }) } as Response;
    }
    if (url.endsWith('/api/session/sync')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }
    if (url.endsWith('/api/step/check-invalidation')) {
      const affected = body.laterCompletedEndpoints.map((endpoint: { id: string }) => ({
        endpointId: endpoint.id,
        reason: 'The account holder name may need to match.',
      }));
      return { ok: true, status: 200, json: async () => ({ affected, degraded: false }) } as Response;
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', stubFetch());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const oneOfEachField: FieldDef[] = [
  { name: 'name', type: 'string', label: 'Name', required: true },
  { name: 'age', type: 'number', label: 'Age', required: false },
  { name: 'subscribe', type: 'boolean', label: 'Subscribe', required: false },
  { name: 'startDate', type: 'date', label: 'Start Date', required: false },
  { name: 'plan', type: 'enum', label: 'Plan', required: true, enumValues: ['free', 'pro'] },
];

function makeFlow(fields: FieldDef[]): FlowDef {
  return {
    id: 'test-flow',
    title: 'Test Flow',
    description: 'A test flow.',
    endpoints: [
      {
        id: 'step1',
        title: 'Step One',
        description: 'The only step.',
        fields,
        execute: vi.fn().mockResolvedValue({ success: true }),
      },
    ],
  };
}

describe('AgentIntakeForm', () => {
  it('maps each FieldDef.type to the expected control', async () => {
    const flow = makeFlow(oneOfEachField);
    render(<AgentIntakeForm flow={flow} apiUrl="http://test.local" />);

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());

    const nameInput = screen.getByLabelText(/Name/) as HTMLInputElement;
    expect(nameInput.tagName).toBe('INPUT');
    expect(nameInput.type).toBe('text');

    const ageInput = screen.getByLabelText(/Age/) as HTMLInputElement;
    expect(ageInput.type).toBe('number');

    const subscribeInput = screen.getByLabelText(/Subscribe/) as HTMLInputElement;
    expect(subscribeInput.type).toBe('checkbox');

    const startDateInput = screen.getByLabelText(/Start Date/) as HTMLInputElement;
    expect(startDateInput.type).toBe('date');

    const planSelect = screen.getByLabelText(/Plan/) as HTMLSelectElement;
    expect(planSelect.tagName).toBe('SELECT');
    expect(Array.from(planSelect.options).map((o) => o.value)).toEqual(['', 'free', 'pro']);
  });

  it('renders the stepper with each endpoint title', async () => {
    const flow = makeFlow(oneOfEachField);
    render(<AgentIntakeForm flow={flow} apiUrl="http://test.local" />);

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    // "Step One" appears both in the stepper <li> and the step's own <h2>.
    expect(screen.getAllByText('Step One').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Step One' })).toBeInTheDocument();
  });

  it('shows a loading indicator while fetching the step fields, then the form', async () => {
    let resolveFetch!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve)))
    );

    const flow = makeFlow(oneOfEachField);
    render(<AgentIntakeForm flow={flow} apiUrl="http://test.local" />);

    expect(screen.getByRole('status')).toHaveTextContent(/Loading/i);

    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({ fields: oneOfEachField, suggestedValues: {}, degraded: false }),
    } as Response);

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.getByLabelText(/Name/)).toBeInTheDocument();
  });

  it('submits the step and shows the completed step in the stepper', async () => {
    const user = userEvent.setup();
    const flow = makeFlow([{ name: 'name', type: 'string', label: 'Name', required: true }]);
    render(<AgentIntakeForm flow={flow} apiUrl="http://test.local" />);

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());

    await user.type(screen.getByLabelText(/Name/), 'Jane');
    await user.click(screen.getByRole('button', { name: /Continue/i }));

    await waitFor(() => expect(screen.getByText('All steps complete.')).toBeInTheDocument());
  });

  it('shows an inline field error when the semantic check rejects the submission', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        if (url.endsWith('/api/step/fields')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ fields: body.endpoint.fields, suggestedValues: {}, degraded: false }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ valid: false, errors: { name: 'That name looks fake.' }, degraded: false }),
        } as Response;
      })
    );

    const user = userEvent.setup();
    const flow = makeFlow([{ name: 'name', type: 'string', label: 'Name', required: true }]);
    render(<AgentIntakeForm flow={flow} apiUrl="http://test.local" />);

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());

    await user.type(screen.getByLabelText(/Name/), 'asdf');
    await user.click(screen.getByRole('button', { name: /Continue/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('That name looks fake.'));
  });

  it("propagates every control type's input through to the submitted data", async () => {
    const execute = vi.fn().mockResolvedValue({ success: true });
    const flow: FlowDef = {
      id: 'test-flow',
      title: 'Test Flow',
      description: 'A test flow.',
      endpoints: [{ id: 'step1', title: 'Step One', fields: oneOfEachField, execute }],
    };
    const user = userEvent.setup();
    render(<AgentIntakeForm flow={flow} apiUrl="http://test.local" />);

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());

    await user.type(screen.getByLabelText(/Name/), 'Jane Doe');
    await user.type(screen.getByLabelText(/Age/), '30');
    await user.click(screen.getByLabelText(/Subscribe/));
    fireEvent.change(screen.getByLabelText(/Start Date/), { target: { value: '2024-06-15' } });
    await user.selectOptions(screen.getByLabelText(/Plan/), 'pro');

    await user.click(screen.getByRole('button', { name: /Continue/i }));

    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledWith(
      { name: 'Jane Doe', age: 30, subscribe: true, startDate: '2024-06-15', plan: 'pro' },
      expect.anything()
    );
  });

  it('renders a fatal error message when the flow has no endpoints', async () => {
    const emptyFlow: FlowDef = { id: 'empty', title: 'Empty', description: 'No endpoints.', endpoints: [] };
    render(<AgentIntakeForm flow={emptyFlow} apiUrl="http://test.local" />);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/no endpoints/i));
  });

  it('shows the execution-failed banner and a Retry button that succeeds', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ success: false, message: 'Downstream failed.' })
      .mockResolvedValueOnce({ success: true });
    const flow: FlowDef = {
      id: 'test-flow',
      title: 'Test Flow',
      description: 'A test flow.',
      endpoints: [
        { id: 'step1', title: 'Step One', fields: [{ name: 'name', type: 'string', label: 'Name', required: true }], execute },
      ],
    };
    const user = userEvent.setup();
    render(<AgentIntakeForm flow={flow} apiUrl="http://test.local" />);

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    await user.type(screen.getByLabelText(/Name/), 'Jane');
    await user.click(screen.getByRole('button', { name: /Continue/i }));

    await waitFor(() => expect(screen.getByText('Downstream failed.')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Retry/i }));

    await waitFor(() => expect(screen.getByText('All steps complete.')).toBeInTheDocument());
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("doesn't repeat the failure message when the explanation already says it", async () => {
    const execute = vi.fn().mockResolvedValueOnce({
      success: false,
      message: 'The service took too long to answer.',
      failure: { kind: 'timeout' },
    });
    const flow: FlowDef = {
      id: 'test-flow',
      title: 'Test Flow',
      description: 'A test flow.',
      endpoints: [
        { id: 'step1', title: 'Step One', fields: [{ name: 'name', type: 'string', label: 'Name', required: true }], execute },
      ],
    };
    const user = userEvent.setup();
    render(<AgentIntakeForm flow={flow} apiUrl="http://test.local" />);

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    await user.type(screen.getByLabelText(/Name/), 'Jane');
    await user.click(screen.getByRole('button', { name: /Continue/i }));

    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(alert.textContent).toContain('Try again.'));
    expect(alert.textContent!.split('The service took too long to answer.').length - 1).toBe(1);
  });

  it('keeps the stepper and submit locked, with the status visible, while a failure is classified', async () => {
    let release!: () => void;
    const answered = new Promise<void>((resolve) => (release = resolve));
    const base = stubFetch();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (!url.endsWith('/api/step/classify-failure')) return base(url, init);
        await answered;
        return {
          ok: true,
          status: 200,
          json: async () => ({ classification: 'needs-edit', explanation: 'Use another bank.', rollbackFromEndpointId: null, degraded: false }),
        } as Response;
      })
    );
    const flow: FlowDef = {
      id: 'test-flow',
      title: 'Test Flow',
      description: 'A test flow.',
      endpoints: [
        { id: 'step1', title: 'Step One', fields: [{ name: 'name', type: 'string', label: 'Name', required: true }], execute: vi.fn().mockResolvedValue({ success: true }) },
        {
          id: 'step2',
          title: 'Step Two',
          fields: [{ name: 'bank', type: 'string', label: 'Bank', required: true }],
          execute: vi.fn().mockResolvedValue({ success: false, message: 'Rejected.', failure: { kind: 'http', status: 422 } }),
        },
      ],
    };
    const user = userEvent.setup();
    render(<AgentIntakeForm flow={flow} apiUrl="http://test.local" />);
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    await user.type(screen.getByLabelText(/Name/), 'Jane');
    await user.click(screen.getByRole('button', { name: /Continue/i }));
    await waitFor(() => expect(screen.getByLabelText(/Bank/)).toBeInTheDocument());
    await user.type(screen.getByLabelText(/Bank/), 'B');
    await user.click(screen.getByRole('button', { name: /Continue/i }));

    await screen.findByText('Checking what went wrong…');
    expect(screen.queryByRole('button', { name: /Step One/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue/i })).toBeDisabled();

    // Typing reopens the step, but the check is still running.
    await user.type(screen.getByLabelText(/Bank/), 'X');
    expect(screen.getByText('Checking what went wrong…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue/i })).toBeDisabled();

    await act(async () => release());
    await waitFor(() => expect(screen.queryByText('Checking what went wrong…')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Step One/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue/i })).toBeEnabled();
  });

  describe('revisiting completed steps', () => {
    function twoStepFlow(update?: ResourceOperations['update']): FlowDef {
      return {
        id: 'two',
        title: 'Two',
        description: 'd',
        endpoints: [
          {
            id: 'account',
            title: 'Account',
            fields: [{ name: 'name', type: 'string', label: 'Name', required: true }],
            operations: {
              create: vi.fn().mockResolvedValue({ success: true, resourceId: 'acct_1' }),
              ...(update ? { update } : {}),
            },
          },
          {
            id: 'payout',
            title: 'Payout',
            fields: [{ name: 'bank', type: 'string', label: 'Bank', required: true }],
            execute: vi.fn().mockResolvedValue({ success: true }),
          },
        ],
      };
    }

    async function completeAccount(user: ReturnType<typeof userEvent.setup>) {
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
      await user.type(screen.getByLabelText(/Name/), 'Jordan');
      await user.click(screen.getByRole('button', { name: /Continue/i }));
      await waitFor(() => expect(screen.getByRole('heading', { name: 'Payout' })).toBeInTheDocument());
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    }

    it('lets the user reopen a completed step, save a change, and marks later steps for review', async () => {
      const update = vi.fn().mockResolvedValue({ success: true });
      const user = userEvent.setup();
      render(<AgentIntakeForm flow={twoStepFlow(update)} apiUrl="http://test.local" />);
      await completeAccount(user);
      await user.type(screen.getByLabelText(/Bank/), 'First Bank');
      await user.click(screen.getByRole('button', { name: /Continue/i }));
      await waitFor(() => expect(screen.getByText('All steps complete.')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /Account/ }));
      await waitFor(() => expect(screen.getByText(/You're changing a step you already completed/)).toBeInTheDocument());
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
      expect(screen.getByLabelText(/Name/)).toHaveValue('Jordan');

      await user.clear(screen.getByLabelText(/Name/));
      await user.type(screen.getByLabelText(/Name/), 'Jordan R.');
      await user.click(screen.getByRole('button', { name: /Save changes/i }));

      await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
      // Payout depends on the changed answer (says the check); it has no update, so it can only be kept.
      await waitFor(() => expect(screen.getByText(/The account holder name may need to match/)).toBeInTheDocument());
      expect(screen.getByText(/keep it if it still applies/)).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Payout' })).toBeInTheDocument();
      expect(screen.getByText(/needs review/)).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: 'Keep as is' }));
      await waitFor(() => expect(screen.getByText('All steps complete.')).toBeInTheDocument());
    });

    it('shows a step without update read-only, with disabled fields and a Back button', async () => {
      const user = userEvent.setup();
      render(<AgentIntakeForm flow={twoStepFlow()} apiUrl="http://test.local" />);
      await completeAccount(user);

      await user.click(screen.getByRole('button', { name: /Account/ }));
      await waitFor(() => expect(screen.getByText(/can't be changed here/)).toBeInTheDocument());
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());

      expect(screen.getByLabelText(/Name/)).toBeDisabled();
      expect(screen.queryByRole('button', { name: /Save changes/i })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Back' }));
      await waitFor(() => expect(screen.getByRole('heading', { name: 'Payout' })).toBeInTheDocument());
    });

    it('does not offer steps that have not been completed yet', async () => {
      render(<AgentIntakeForm flow={twoStepFlow()} apiUrl="http://test.local" />);
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());

      expect(screen.queryByRole('button', { name: /Payout/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Account/ })).not.toBeInTheDocument();
    });
  });

  describe('recovering from a failed step', () => {
    it('proposes undoing earlier steps, runs it only after confirmation, and reports what was undone', async () => {
      const base = stubFetch();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          if (url.endsWith('/api/step/classify-failure')) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                classification: 'fundamental',
                explanation: 'The account is on hold, so payouts cannot be added.',
                rollbackFromEndpointId: 'account',
                degraded: false,
              }),
            } as Response;
          }
          return base(url, init);
        })
      );
      const undo = vi.fn().mockResolvedValue({ success: true });
      const flow: FlowDef = {
        id: 'recover',
        title: 'Recover',
        description: 'd',
        endpoints: [
          {
            id: 'account',
            title: 'Account',
            fields: [{ name: 'name', type: 'string', label: 'Name', required: true }],
            operations: { create: vi.fn().mockResolvedValue({ success: true, resourceId: 'acct_1' }), undo },
          },
          {
            id: 'payout',
            title: 'Payout',
            fields: [{ name: 'bank', type: 'string', label: 'Bank', required: true }],
            operations: {
              create: vi.fn().mockResolvedValue({
                success: false,
                message: 'Request rejected.',
                failure: { kind: 'http', status: 403, message: 'account on compliance hold' },
              }),
            },
          },
        ],
      };
      const user = userEvent.setup();
      render(<AgentIntakeForm flow={flow} apiUrl="http://test.local" />);
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
      await user.type(screen.getByLabelText(/Name/), 'Jordan');
      await user.click(screen.getByRole('button', { name: /Continue/i }));
      await waitFor(() => expect(screen.getByRole('heading', { name: 'Payout' })).toBeInTheDocument());
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
      await user.type(screen.getByLabelText(/Bank/), 'Hold Bank');
      await user.click(screen.getByRole('button', { name: /Continue/i }));

      await waitFor(() => expect(screen.getByText(/The account is on hold/)).toBeInTheDocument());
      expect(screen.getByText(/Nothing is undone unless you confirm/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
      expect(undo).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Undo these steps' }));

      await waitFor(() => expect(screen.getByText(/Undone: Account/)).toBeInTheDocument());
      expect(undo).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'acct_1' }));
      await waitFor(() => expect(screen.getByRole('heading', { name: 'Account' })).toBeInTheDocument());
    });
  });
});
