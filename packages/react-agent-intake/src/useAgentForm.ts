import { useCallback, useRef, useState } from 'react';

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface UseAgentFormOptions {
  /** Your backend's POST /api/conversation endpoint. LLM calls never happen here. */
  apiUrl: string;
  flowId: string;
}

export interface UseAgentFormResult {
  messages: AgentMessage[];
  sendMessage: (text: string) => Promise<void>;
  isComplete: boolean;
  completedEndpoints: string[];
  totalEndpoints: number;
  loading: boolean;
  error: Error | null;
  reset: () => void;
}

function generateSessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Headless hook for a conversational multi-endpoint intake flow.
 *
 * Manages the session id internally and talks only to your own backend —
 * the Anthropic API key never reaches the browser.
 */
export function useAgentForm({ apiUrl, flowId }: UseAgentFormOptions): UseAgentFormResult {
  const sessionIdRef = useRef<string | null>(null);
  const loadingRef = useRef(false);

  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [isComplete, setIsComplete] = useState(false);
  const [completedEndpoints, setCompletedEndpoints] = useState<string[]>([]);
  const [totalEndpoints, setTotalEndpoints] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || loadingRef.current) return;

      loadingRef.current = true;
      setLoading(true);
      setError(null);
      setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);

      try {
        if (!sessionIdRef.current) {
          sessionIdRef.current = generateSessionId();
        }

        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: sessionIdRef.current,
            flowId,
            message: trimmed,
          }),
        });

        if (!res.ok) {
          let message = `Request failed with status ${res.status}`;
          try {
            const body = await res.json();
            if (body?.error) message = body.error;
          } catch {
            // non-JSON error body; keep the status-based message
          }
          throw new Error(message);
        }

        const data = await res.json();
        setMessages((prev) => [...prev, { role: 'assistant', content: data.reply }]);
        setIsComplete(!!data.isComplete);
        setCompletedEndpoints(Array.isArray(data.completedEndpoints) ? data.completedEndpoints : []);
        setTotalEndpoints(typeof data.totalEndpoints === 'number' ? data.totalEndpoints : 0);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [apiUrl, flowId],
  );

  const reset = useCallback(() => {
    sessionIdRef.current = null;
    setMessages([]);
    setIsComplete(false);
    setCompletedEndpoints([]);
    setTotalEndpoints(0);
    setError(null);
  }, []);

  return {
    messages,
    sendMessage,
    isComplete,
    completedEndpoints,
    totalEndpoints,
    loading,
    error,
    reset,
  };
}
