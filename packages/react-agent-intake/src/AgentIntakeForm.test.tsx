// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FieldDef, FlowDef } from './contracts.js';
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
});
