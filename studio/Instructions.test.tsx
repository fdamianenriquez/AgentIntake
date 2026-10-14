// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUIDANCE_LIMITS, type GeneratedFlow } from '../packages/react-agent-intake/src/contracts.js';
import { FlowPreview } from './FlowPreview.js';
import { Instructions } from './Instructions.js';
import type { GenerateResponse } from './SpecInput.js';

const field = (name: string) => ({ name, type: 'string' as const, label: name, required: true });
const flow: GeneratedFlow = {
  id: 'onboarding',
  title: 'Onboarding',
  description: 'd',
  endpoints: [
    { id: 'account', title: 'Account', fields: [field('name')] },
    { id: 'payout', title: 'Payout', fields: [field('bank')] },
  ],
};

const PROMPT_HEAD = 'You are validating one step.\n\n';
const BLOCK = 'Guidance from the author of this form.\n<<<AUTHOR_GUIDANCE\nTone: Formal.\nAUTHOR_GUIDANCE>>>\n\n';
const PROMPT_TAIL = 'Fields (JSON): ...';

interface Calls {
  posts: { url: string; body: any }[];
}

// Studio's server, as the tab sees it.
function stubStudio(overrides: Partial<Record<string, (body: any) => { status?: number; json: unknown }>> = {}) {
  const calls: Calls = { posts: [] };
  let polls = 0;
  const reply = (status: number, json: unknown) => ({ ok: status < 400, status, json: async () => json }) as Response;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      if (method !== 'GET') calls.posts.push({ url, body });
      const key = `${method} ${url.split('?')[0]}`;
      const override = overrides[key];
      if (override) {
        const { status = 200, json } = override(body);
        return reply(status, json);
      }
      switch (key) {
        case 'GET /api/studio/config':
          return reply(200, { guidance: { tone: 'Formal.' }, path: '/project/agentintake.config.json', limits: GUIDANCE_LIMITS });
        case 'POST /api/studio/config':
          return reply(200, { config: { guidance: body.guidance }, path: '/project/agentintake.config.json' });
        case 'POST /api/studio/render-prompt':
          return reply(200, {
            prompt: PROMPT_HEAD + BLOCK + PROMPT_TAIL,
            guidanceRange: { start: PROMPT_HEAD.length, end: PROMPT_HEAD.length + BLOCK.length },
          });
        case 'GET /api/studio/evals/cases':
          return reply(200, { stepIds: ['createAccount', 'createVerification', 'createPayoutMethod'] });
        case 'GET /api/studio/evals/plan':
          return reply(200, { runs: 4, provider: 'openrouter', model: 'some/model' });
        case 'POST /api/studio/evals':
          return reply(202, { jobId: 'job-1', runs: 4 });
        case 'GET /api/studio/evals/job-1':
          polls++;
          return polls < 2
            ? reply(200, { status: 'running', done: 1, total: 4 })
            : reply(200, {
                status: 'done',
                done: 4,
                total: 4,
                report: {
                  calls: {
                    validate: {
                      runs: 4,
                      passed: 3,
                      degraded: 0,
                      passRate: 0.75,
                      p50Ms: 2100,
                      p95Ms: 3400,
                      failures: [{ name: 'a holder in capitals', run: 1, reason: 'valid was true, expected false', got: { valid: true } }],
                    },
                  },
                },
              });
        case 'DELETE /api/studio/evals/job-1':
          return reply(200, { status: 'running', done: 1, total: 4 });
        case 'POST /api/step/fields':
          return reply(200, { fields: body.endpoint.fields, suggestedValues: {}, degraded: false });
      }
      throw new Error(`unexpected ${key}`);
    })
  );
  return calls;
}

const timings = { debounceMs: 0, pollMs: 10 };

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderTab(onFlowChange = vi.fn(), current: GeneratedFlow = flow) {
  return render(<Instructions flow={current} onFlowChange={onFlowChange} timings={timings} />);
}

describe('global guidance', () => {
  it('shows the saved guidance with a counter per slot, and flags text over the limit', async () => {
    stubStudio();
    const user = userEvent.setup();
    renderTab();

    const tone = await screen.findByLabelText('Tone');
    expect(tone).toHaveValue('Formal.');
    expect(screen.getByText(`7 / ${GUIDANCE_LIMITS.tone}`)).toBeInTheDocument();

    await user.clear(tone);
    await user.click(tone);
    await user.paste('x'.repeat(GUIDANCE_LIMITS.tone + 1));

    expect(screen.getByText(`Too long: at most ${GUIDANCE_LIMITS.tone} characters.`)).toHaveAttribute('role', 'alert');
    expect(tone).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Save global guidance' })).toBeDisabled();
  });

  it('checks the output language is a BCP-47 tag', async () => {
    stubStudio();
    const user = userEvent.setup();
    renderTab();

    await user.type(await screen.findByLabelText('Output language'), 'not a language');

    expect(screen.getByText(/Use a BCP-47 language tag/)).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('button', { name: 'Save global guidance' })).toBeDisabled();
  });

  it('saves, with extra rules per call, and says where', async () => {
    const calls = stubStudio();
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole('button', { name: 'Add a rule (Checking answers)' }));
    await user.type(screen.getByLabelText('Checking answers: rule 1'), 'Accept P.O. boxes.');
    await user.click(screen.getByRole('button', { name: 'Save global guidance' }));

    expect(await screen.findByText('Saved to /project/agentintake.config.json.')).toHaveAttribute('role', 'status');
    expect(calls.posts.find((post) => post.url === '/api/studio/config')!.body).toEqual({
      guidance: { tone: 'Formal.', extraRules: { validate: ['Accept P.O. boxes.'] } },
    });
  });

  it('shows the server\'s validation errors next to the field', async () => {
    stubStudio({
      'POST /api/studio/config': () => ({
        status: 400,
        json: { error: 'The guidance is invalid.', issues: [{ path: 'guidance.tone', message: 'The server rejected this tone.' }] },
      }),
    });
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole('button', { name: 'Save global guidance' }));

    expect(await screen.findByText('The server rejected this tone.')).toHaveAttribute('role', 'alert');
    expect(screen.getByText('The guidance is invalid.')).toHaveAttribute('role', 'alert');
  });
});

describe('flow and step guidance', () => {
  it('edits the flow in memory, with counters', async () => {
    stubStudio();
    const user = userEvent.setup();
    const onFlowChange = vi.fn();
    renderTab(onFlowChange);

    await user.type(screen.getByLabelText('Guidance for the step "Payout"'), 'H');

    expect(onFlowChange).toHaveBeenLastCalledWith({
      ...flow,
      endpoints: [flow.endpoints[0], { ...flow.endpoints[1], guidance: 'H' }],
    });
    expect(screen.getAllByText(`0 / ${GUIDANCE_LIMITS.endpointGuidance}`)).toHaveLength(2);
  });

  it('is in the downloaded flow.json; empty fields are left out', async () => {
    stubStudio();
    const user = userEvent.setup();
    let downloaded: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      downloaded = blob as Blob;
      return 'blob:flow';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const generation: GenerateResponse = { flow, ambiguousFields: [], warnings: [] };
    render(<FlowPreview generation={generation} onReset={vi.fn()} timings={timings} />);

    await user.click(screen.getByRole('tab', { name: 'Instructions' }));
    await user.type(screen.getByLabelText('Flow guidance'), 'Small sellers.');
    await user.type(screen.getByLabelText('Guidance for the step "Account"'), 'Names have accents.');
    await user.click(screen.getByRole('button', { name: 'Download flow.json' }));

    const saved = JSON.parse(await downloaded!.text());
    expect(saved.guidance).toBe('Small sellers.');
    expect(saved).not.toHaveProperty('outputLanguage');
    expect(saved.endpoints[0].guidance).toBe('Names have accents.');
    expect(saved.endpoints[1]).not.toHaveProperty('guidance');
  });

  it('blocks the download while the guidance is invalid', async () => {
    stubStudio();
    const user = userEvent.setup();
    render(<FlowPreview generation={{ flow, ambiguousFields: [], warnings: [] }} onReset={vi.fn()} timings={timings} />);

    await user.click(screen.getByRole('tab', { name: 'Instructions' }));
    await user.type(screen.getByLabelText('Flow output language'), '???');

    expect(screen.getByRole('button', { name: 'Download flow.json' })).toBeDisabled();
  });

  it('the live preview sends the current flow guidance', async () => {
    stubStudio();
    const user = userEvent.setup();
    render(<FlowPreview generation={{ flow, ambiguousFields: [], warnings: [] }} onReset={vi.fn()} timings={timings} />);

    await user.click(screen.getByRole('tab', { name: 'Instructions' }));
    await user.type(screen.getByLabelText('Flow guidance'), 'Small sellers.');
    await user.type(screen.getByLabelText('Guidance for the step "Payout"'), 'Holder must match.');
    await user.click(screen.getByRole('tab', { name: 'Preview' }));
    await user.type(await screen.findByLabelText(/name/), 'Jo');
    await user.click(screen.getByRole('button', { name: /Continue/ }));

    // The next step's runtime call carries the guidance typed above.
    await waitFor(() => {
      const payoutFields = vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url).endsWith('/api/step/fields'))
        .map(([, init]) => JSON.parse((init as RequestInit).body as string))
        .find((body) => body.endpoint.id === 'payout');
      expect(payoutFields).toMatchObject({
        flow: { id: 'onboarding', guidance: 'Small sellers.' },
        endpoint: { guidance: 'Holder must match.' },
      });
    });
  });
});

describe('what the model receives', () => {
  it('highlights the guidance block and marks the rest read-only', async () => {
    const calls = stubStudio();
    renderTab();

    const prompt = await screen.findByLabelText('Rendered prompt');
    const block = prompt.querySelector('[data-guidance]')!;
    expect(block.tagName).toBe('MARK');
    expect(block.textContent).toBe(BLOCK);
    expect([...prompt.querySelectorAll('[data-locked]')].map((part) => part.textContent)).toEqual([PROMPT_HEAD, PROMPT_TAIL]);
    expect(calls.posts.find((post) => post.url === '/api/studio/render-prompt')!.body).toMatchObject({
      call: 'validate',
      endpointId: 'account',
    });
  });

  it('asks again for the step and call picked', async () => {
    const calls = stubStudio();
    const user = userEvent.setup();
    renderTab();
    await screen.findByLabelText('Rendered prompt');

    await user.selectOptions(screen.getByLabelText('Call'), 'classifyFailure');
    await user.selectOptions(screen.getByLabelText('Step'), 'payout');

    await waitFor(() =>
      expect(calls.posts.filter((post) => post.url === '/api/studio/render-prompt').at(-1)!.body).toMatchObject({
        call: 'classifyFailure',
        endpointId: 'payout',
      })
    );
  });
});

describe('Test', () => {
  it('asks first with the run count and model, then shows progress and the report', async () => {
    const calls = stubStudio();
    const user = userEvent.setup();
    renderTab();
    await screen.findByLabelText('Tone');

    await user.click(screen.getByRole('button', { name: 'Test' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('This will make 4 run(s) -- at least 4 model call(s) -- with openrouter / some/model.');
    expect(calls.posts.some((post) => post.url === '/api/studio/evals')).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: 'Run 4 test run(s)' }));

    expect(await screen.findByText('Running: 0 / 4')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled();
    const table = await screen.findByRole('table', { name: 'Results' });
    expect(within(table).getByRole('row', { name: /Checking answers 4 3 75% 0 2.1 s 3.4 s/ })).toBeInTheDocument();
    expect(screen.getByText(/a holder in capitals/)).toBeInTheDocument();
    expect(screen.getByText(/valid was true, expected false/)).toBeInTheDocument();
    expect(calls.posts.find((post) => post.url === '/api/studio/evals')!.body).toMatchObject({ flow: { id: 'onboarding' } });
  });

  it('"Don\'t run" makes no run', async () => {
    const calls = stubStudio();
    const user = userEvent.setup();
    renderTab();
    await screen.findByLabelText('Tone');

    await user.click(screen.getByRole('button', { name: 'Test' }));
    await user.click(await screen.findByRole('button', { name: "Don't run" }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(calls.posts.some((post) => post.url === '/api/studio/evals')).toBe(false);
  });

  it('can be cancelled while running', async () => {
    const calls = stubStudio({ 'GET /api/studio/evals/job-1': () => ({ json: { status: 'running', done: 1, total: 4 } }) });
    const user = userEvent.setup();
    renderTab();
    await screen.findByLabelText('Tone');

    await user.click(screen.getByRole('button', { name: 'Test' }));
    await user.click(await screen.findByRole('button', { name: 'Run 4 test run(s)' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel the test' }));

    expect(calls.posts.some((post) => post.url === '/api/studio/evals/job-1')).toBe(true);
  });

  it('selects the calls whose guidance changed since the last test', async () => {
    stubStudio();
    const user = userEvent.setup();
    const { rerender } = renderTab();
    await screen.findByLabelText('Tone');
    // Before any test, every call is selected.
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Test' }));
    await user.click(await screen.findByRole('button', { name: 'Run 4 test run(s)' }));
    await screen.findByRole('table', { name: 'Results' });

    // Step guidance changes what every call but generation receives.
    rerender(
      <Instructions
        flow={{ ...flow, endpoints: [{ ...flow.endpoints[0], guidance: 'New.' }, flow.endpoints[1]] }}
        onFlowChange={vi.fn()}
        timings={timings}
      />
    );
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Flow generation/ })).not.toBeChecked());
    expect(screen.getByRole('checkbox', { name: /Checking answers \(changed\)/ })).toBeChecked();
  });
});

describe('what Test covers', () => {
  it('says it uses the built-in example cases, and that step guidance needs matching step ids', async () => {
    stubStudio();
    renderTab();

    expect(await screen.findByText(/uses AgentIntake's built-in example cases/)).toBeInTheDocument();
    expect(screen.getByText(/step guidance only applies to steps with the same id/i)).toBeInTheDocument();
    expect(screen.queryByText(/isn't covered by this test/)).not.toBeInTheDocument();
  });

  it('says so when this flow\'s step guidance can\'t reach any built-in case', async () => {
    stubStudio();
    renderTab(vi.fn(), { ...flow, endpoints: [{ ...flow.endpoints[0], guidance: 'Names have accents.' }, flow.endpoints[1]] });

    expect(await screen.findByText(/Your step guidance isn't covered by this test/)).toHaveAttribute('role', 'note');
  });

  it('does not warn when a step with guidance has a built-in case\'s id', async () => {
    stubStudio();
    renderTab(vi.fn(), { ...flow, endpoints: [{ ...flow.endpoints[0], id: 'createAccount', guidance: 'G.' }, flow.endpoints[1]] });

    await screen.findByText(/uses AgentIntake's built-in example cases/);
    expect(screen.queryByText(/isn't covered by this test/)).not.toBeInTheDocument();
  });
});
