// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderSetup } from './ProviderSetup.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ProviderSetup', () => {
  it('submits the chosen provider and key, then calls onDone on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
    const onDone = vi.fn();
    const user = userEvent.setup();

    render(<ProviderSetup onDone={onDone} />);

    await user.selectOptions(screen.getByLabelText('Provider'), 'openrouter');
    await user.type(screen.getByLabelText('API key'), 'sk-test-123');
    await user.click(screen.getByRole('button', { name: /Save and continue/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/provider-setup',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ provider: 'openrouter', apiKey: 'sk-test-123' }),
      })
    );
  });

  it('shows the server error and does not call onDone when setup fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'Invalid API key.' }) }));
    const onDone = vi.fn();
    const user = userEvent.setup();

    render(<ProviderSetup onDone={onDone} />);

    await user.type(screen.getByLabelText('API key'), 'bad-key');
    await user.click(screen.getByRole('button', { name: /Save and continue/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Invalid API key.'));
    expect(onDone).not.toHaveBeenCalled();
  });

  it('disables the submit button until an API key is entered', async () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<ProviderSetup onDone={vi.fn()} />);

    expect(screen.getByRole('button', { name: /Save and continue/i })).toBeDisabled();
  });
});
