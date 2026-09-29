// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpecInput } from './SpecInput.js';

const VALID_SPEC = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Fixture API', version: '1.0.0' },
  paths: {},
});

const GENERATE_RESPONSE = {
  flow: { id: 'flow', title: 'Flow', description: 'A flow.', endpoints: [] },
  ambiguousFields: [],
  warnings: [],
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SpecInput', () => {
  it('rejects pasted text that is not parseable OpenAPI, without calling the server', async () => {
    const user = userEvent.setup();
    const onGenerated = vi.fn();
    render(<SpecInput onGenerated={onGenerated} />);

    fireEvent.change(screen.getByPlaceholderText(/Paste your OpenAPI spec/), {
      target: { value: 'not json or yaml : : {{{' },
    });
    await user.click(screen.getByRole('button', { name: /^Generate$/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("doesn't look like a valid OpenAPI file"));
    expect(fetch).not.toHaveBeenCalled();
    expect(onGenerated).not.toHaveBeenCalled();
  });

  it('sends pasted text as specContent and calls onGenerated on success', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => GENERATE_RESPONSE } as Response);
    const user = userEvent.setup();
    const onGenerated = vi.fn();
    render(<SpecInput onGenerated={onGenerated} />);

    fireEvent.change(screen.getByPlaceholderText(/Paste your OpenAPI spec/), { target: { value: VALID_SPEC } });
    await user.click(screen.getByRole('button', { name: /^Generate$/ }));

    await waitFor(() => expect(onGenerated).toHaveBeenCalledWith(GENERATE_RESPONSE));
    expect(fetch).toHaveBeenCalledWith(
      '/api/generate-flow',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ specContent: VALID_SPEC }) })
    );
  });

  it('surfaces the server error message when generation fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'No write operations found.' }),
    } as Response);
    const user = userEvent.setup();
    render(<SpecInput onGenerated={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText(/Paste your OpenAPI spec/), { target: { value: VALID_SPEC } });
    await user.click(screen.getByRole('button', { name: /^Generate$/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('No write operations found.'));
  });

  it('mentions CORS as a possible cause when a pasted URL fails to fetch', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const user = userEvent.setup();
    render(<SpecInput onGenerated={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Paste a URL/i }));
    await user.type(screen.getByPlaceholderText(/https:\/\/example.com/), 'https://blocked.example.com/spec.yaml');
    await user.click(screen.getByRole('button', { name: /^Generate$/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/CORS/));
  });

  it("reports the HTTP status when a pasted URL is reachable but doesn't return OK", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    const user = userEvent.setup();
    render(<SpecInput onGenerated={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Paste a URL/i }));
    await user.type(screen.getByPlaceholderText(/https:\/\/example.com/), 'https://example.com/missing.yaml');
    await user.click(screen.getByRole('button', { name: /^Generate$/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('HTTP 404'));
  });

  it('reads an uploaded file client-side and sends its content as specContent', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => GENERATE_RESPONSE } as Response);
    const user = userEvent.setup();
    const onGenerated = vi.fn();
    render(<SpecInput onGenerated={onGenerated} />);

    await user.click(screen.getByRole('button', { name: /Upload a file/i }));
    const file = new File([VALID_SPEC], 'spec.json', { type: 'application/json' });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, file);
    await user.click(screen.getByRole('button', { name: /^Generate$/ }));

    await waitFor(() => expect(onGenerated).toHaveBeenCalledWith(GENERATE_RESPONSE));
    expect(fetch).toHaveBeenCalledWith(
      '/api/generate-flow',
      expect.objectContaining({ body: JSON.stringify({ specContent: VALID_SPEC }) })
    );
  });

  it('prompts for input before attempting to resolve content in each mode', async () => {
    const user = userEvent.setup();
    render(<SpecInput onGenerated={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /^Generate$/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Paste a spec first.'));

    await user.click(screen.getByRole('button', { name: /Paste a URL/i }));
    await user.click(screen.getByRole('button', { name: /^Generate$/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Paste a spec URL first.'));

    await user.click(screen.getByRole('button', { name: /Upload a file/i }));
    await user.click(screen.getByRole('button', { name: /^Generate$/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Choose a file first.'));

    expect(fetch).not.toHaveBeenCalled();
  });
});
