// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowPreview } from './FlowPreview.js';
import type { GenerateResponse } from './SpecInput.js';

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

const generation: GenerateResponse = {
  flow: {
    id: 'flow',
    title: 'Test Flow',
    description: 'A flow.',
    endpoints: [
      {
        id: 'step1',
        title: 'Step One',
        fields: [{ name: 'name', type: 'string', label: 'Name', required: true }],
        auth: { type: 'none' },
      },
    ],
  },
  ambiguousFields: [{ endpointId: 'step1', fieldName: 'name', note: 'Purpose unclear.' }],
  warnings: ['Found 16 write operations, more than v1 is tuned for.'],
};

describe('FlowPreview', () => {
  it('shows the preview-mode banner, warnings, and flagged ambiguous fields', async () => {
    render(<FlowPreview generation={generation} onReset={vi.fn()} />);

    expect(screen.getByText(/Preview mode/)).toBeInTheDocument();
    expect(screen.getByText(/Found 16 write operations/)).toBeInTheDocument();

    await waitFor(() => expect(screen.getByLabelText(/Name/)).toBeInTheDocument());

    expect(screen.getByText('step1.name:')).toBeInTheDocument();
    expect(screen.getByText('Purpose unclear.')).toBeInTheDocument();
  });

  it('omits the warnings list and ambiguous-fields section when both are empty', async () => {
    const clean: GenerateResponse = { ...generation, ambiguousFields: [], warnings: [] };
    render(<FlowPreview generation={clean} onReset={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText(/Name/)).toBeInTheDocument());

    expect(screen.queryByText(/Found 16 write operations/)).not.toBeInTheDocument();
    expect(screen.queryByText('Flagged for review')).not.toBeInTheDocument();
  });

  it('logs "[Preview mode]" when the simulated execute() runs on submit, instead of hitting a real API', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const user = userEvent.setup();
    render(<FlowPreview generation={generation} onReset={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText(/Name/)).toBeInTheDocument());
    await user.type(screen.getByLabelText(/Name/), 'Jane');
    await user.click(screen.getByRole('button', { name: /Continue/i }));

    await waitFor(() =>
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Preview mode] Would call the "Step One" endpoint (step1) with:'),
        { name: 'Jane' }
      )
    );

    logSpy.mockRestore();
  });

  it('downloads flow.json (without the simulated execute()) when "Download flow.json" is clicked', async () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const user = userEvent.setup();
    render(<FlowPreview generation={generation} onReset={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText(/Name/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Download flow\.json/i }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const [blob] = createObjectURL.mock.calls[0] as [Blob];
    expect(blob.type).toBe('application/json');
    const text = await blob.text();
    expect(JSON.parse(text)).toEqual(generation.flow);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');

    clickSpy.mockRestore();
  });

  it('calls onReset when "Start over" is clicked', async () => {
    const onReset = vi.fn();
    const user = userEvent.setup();
    render(<FlowPreview generation={generation} onReset={onReset} />);

    await waitFor(() => expect(screen.getByLabelText(/Name/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Start over/i }));

    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('simulates the read/update the parser found, so revisiting a step can be previewed', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const withFamily: GenerateResponse = {
      ...generation,
      flow: {
        ...generation.flow,
        endpoints: [
          {
            ...generation.flow.endpoints[0],
            capabilities: { read: true, update: true, undo: false },
            resourcePath: '/things',
            idParam: 'thingId',
          },
          { id: 'step2', title: 'Step Two', fields: [{ name: 'other', type: 'string', label: 'Other', required: true }] },
        ],
      },
    };
    const user = userEvent.setup();
    render(<FlowPreview generation={withFamily} onReset={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/Name/)).toBeInTheDocument());
    await user.type(screen.getByLabelText(/Name/), 'Jane');
    await user.click(screen.getByRole('button', { name: /Continue/i }));
    await waitFor(() => expect(screen.getByLabelText(/Other/)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Step One/ }));
    await waitFor(() => expect(screen.getByLabelText(/Name/)).toHaveValue('Jane'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Would read sim-step1-1'));

    await user.clear(screen.getByLabelText(/Name/));
    await user.type(screen.getByLabelText(/Name/), 'Janet');
    await user.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() =>
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Would update sim-step1-1'), { name: 'Janet' })
    );
    logSpy.mockRestore();
  });
});
