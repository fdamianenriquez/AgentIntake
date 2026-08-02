import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentForm } from '../useAgentForm';

const fetchMock = vi.fn<typeof fetch>();

function ok(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

function notOk(status: number, body: unknown): Response {
  return { ok: false, status, json: async () => body } as Response;
}

function requestBody(callIndex: number): { sessionId: string; flowId: string; message: string } {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(init.body as string);
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock;
});

describe('useAgentForm', () => {
  it('posts to the apiUrl and appends user + assistant messages', async () => {
    fetchMock.mockResolvedValue(
      ok({ reply: 'Hi! What is your name?', isComplete: false, completedEndpoints: [], totalEndpoints: 3 }),
    );

    const { result } = renderHook(() =>
      useAgentForm({ apiUrl: 'http://localhost:4000/api/conversation', flowId: 'job_application_intake' }),
    );

    await act(async () => {
      await result.current.sendMessage('hello');
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:4000/api/conversation');

    const body = requestBody(0);
    expect(body.message).toBe('hello');
    expect(body.flowId).toBe('job_application_intake');
    expect(body.sessionId).toBeTruthy();

    expect(result.current.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hi! What is your name?' },
    ]);
    expect(result.current.totalEndpoints).toBe(3);
  });

  it('keeps the sessionId stable across sends', async () => {
    fetchMock.mockResolvedValue(
      ok({ reply: 'ok', isComplete: false, completedEndpoints: [], totalEndpoints: 1 }),
    );

    const { result } = renderHook(() =>
      useAgentForm({ apiUrl: 'http://localhost:4000/api/conversation', flowId: 'f' }),
    );

    await act(async () => {
      await result.current.sendMessage('first');
    });
    await act(async () => {
      await result.current.sendMessage('second');
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBody(0).sessionId).toBe(requestBody(1).sessionId);
  });

  it('updates completion and endpoints from the response', async () => {
    fetchMock.mockResolvedValue(
      ok({ reply: 'done', isComplete: true, completedEndpoints: ['a', 'b'], totalEndpoints: 2 }),
    );

    const { result } = renderHook(() => useAgentForm({ apiUrl: 'http://api', flowId: 'f' }));

    await act(async () => {
      await result.current.sendMessage('x');
    });

    expect(result.current.isComplete).toBe(true);
    expect(result.current.completedEndpoints).toEqual(['a', 'b']);
  });

  it('exposes an error when the request fails', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useAgentForm({ apiUrl: 'http://api', flowId: 'f' }));

    await act(async () => {
      await result.current.sendMessage('x');
    });

    expect(result.current.error?.message).toBe('network down');
    expect(result.current.loading).toBe(false);
    expect(result.current.messages).toEqual([{ role: 'user', content: 'x' }]);
  });

  it('surfaces server-side error messages for non-2xx responses', async () => {
    fetchMock.mockResolvedValue(notOk(500, { error: 'ANTHROPIC_API_KEY is not set' }));

    const { result } = renderHook(() => useAgentForm({ apiUrl: 'http://api', flowId: 'f' }));

    await act(async () => {
      await result.current.sendMessage('x');
    });

    expect(result.current.error?.message).toBe('ANTHROPIC_API_KEY is not set');
  });

  it('ignores empty messages', async () => {
    fetchMock.mockResolvedValue(
      ok({ reply: 'hi', isComplete: false, completedEndpoints: [], totalEndpoints: 1 }),
    );

    const { result } = renderHook(() => useAgentForm({ apiUrl: 'http://api', flowId: 'f' }));

    await act(async () => {
      await result.current.sendMessage('   ');
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([]);
  });
});
