// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUIDANCE_LIMITS } from '../packages/react-agent-intake/src/contracts.js';
import type { GenerateResponse } from './SpecInput.js';

const field = (name: string) => ({ name, type: 'string' as const, label: name, required: true });
const generations: GenerateResponse[] = [
  {
    flow: {
      id: 'f',
      title: 'F',
      description: 'd',
      endpoints: [
        { id: 'account', title: 'Account', fields: [field('name')] },
        { id: 'oldStep', title: 'Old Step', fields: [field('x')] },
      ],
    },
    ambiguousFields: [],
    warnings: [],
  },
  {
    flow: {
      id: 'f',
      title: 'F',
      description: 'd',
      endpoints: [
        { id: 'account', title: 'Your Account', fields: [field('name')] },
        { id: 'newStep', title: 'New Step', fields: [field('y')] },
      ],
    },
    ambiguousFields: [],
    warnings: [],
  },
];

// The spec input itself is tested on its own; here it just hands out the
// next generated flow.
vi.mock('./SpecInput.js', () => ({
  SpecInput: ({ onGenerated }: { onGenerated: (result: GenerateResponse) => void }) => (
    <button type="button" onClick={() => onGenerated(generations.shift()!)}>
      Generate
    </button>
  ),
}));

import { App } from './App.js';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
      if (url === '/api/provider-status') return json({ configured: true });
      if (url === '/api/studio/config') return json({ guidance: {}, path: '/p/agentintake.config.json', limits: GUIDANCE_LIMITS });
      if (url === '/api/studio/render-prompt') return json({ prompt: 'p', guidanceRange: null });
      if (url === '/api/step/fields') return json({ fields: JSON.parse(init.body as string).endpoint.fields, suggestedValues: {}, degraded: false });
      throw new Error(`unexpected ${url}`);
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('regenerating a flow in the same session', () => {
  it('keeps the flow and step guidance by endpoint id, and lists the steps whose guidance was dropped', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Generate' }));
    await user.click(screen.getByRole('tab', { name: 'Instructions' }));
    await user.type(screen.getByLabelText('Flow guidance'), 'Small sellers.');
    await user.type(screen.getByLabelText('Guidance for the step "Account"'), 'Names have accents.');
    await user.type(screen.getByLabelText('Guidance for the step "Old Step"'), 'Old guidance.');
    await user.click(screen.getByRole('button', { name: 'Start over' }));

    await user.click(await screen.findByRole('button', { name: 'Generate' }));
    await user.click(screen.getByRole('tab', { name: 'Instructions' }));

    expect(screen.getByLabelText('Flow guidance')).toHaveValue('Small sellers.');
    expect(screen.getByLabelText('Guidance for the step "Your Account"')).toHaveValue('Names have accents.');
    expect(screen.getByLabelText('Guidance for the step "New Step"')).toHaveValue('');
    expect(screen.getByText(/except for steps that no longer exist: Old Step\./)).toHaveAttribute('role', 'status');
  });
});
