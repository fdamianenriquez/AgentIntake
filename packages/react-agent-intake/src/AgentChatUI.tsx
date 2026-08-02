import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAgentForm } from './useAgentForm';

export interface AgentChatUIProps {
  apiUrl: string;
  flowId: string;
  title?: string;
  description?: string;
  /** Endpoint ids for the live checklist. Populate from your backend's /api/flows. */
  endpoints?: string[];
  endpointLabels?: Record<string, string>;
}

/**
 * Minimal, usable chat UI for an AgentIntake flow.
 *
 * The endpoint checklist is the key visual proof of the concept: each entry
 * ticks off as soon as its endpoint fires mid-conversation, well before the
 * intake is complete — showing these are separate calls to separate services,
 * not one form with one submit button.
 */
export function AgentChatUI({
  apiUrl,
  flowId,
  title = 'AgentIntake',
  description,
  endpoints = [],
  endpointLabels = {},
}: AgentChatUIProps) {
  const { messages, sendMessage, isComplete, completedEndpoints, totalEndpoints, loading, error } =
    useAgentForm({ apiUrl, flowId });

  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const text = draft;
    setDraft('');
    await sendMessage(text);
  };

  const checklist = endpoints.map((id) => ({
    id,
    label: endpointLabels[id] ?? id,
    done: completedEndpoints.includes(id),
  }));

  const progress = totalEndpoints > 0 ? completedEndpoints.length / totalEndpoints : 0;

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ padding: 16, paddingBottom: 8 }}>
        <h2 style={{ margin: 0, marginBottom: 4 }}>{title}</h2>
        {description && <p style={{ margin: 0, color: '#555', fontSize: 14 }}>{description}</p>}
      </div>

      {checklist.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: '0 16px 8px', fontSize: 14 }}>
          {checklist.map((item) => (
            <li key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
              <span style={{ color: item.done ? '#2e7d32' : '#999', width: 16 }}>{item.done ? '✓' : '○'}</span>
              <span>
                {item.label}
                {item.done && <em style={{ color: '#2e7d32', marginLeft: 6 }}>submitted</em>}
              </span>
            </li>
          ))}
        </ul>
      )}

      {totalEndpoints > 0 && (
        <div style={{ padding: '0 16px 8px', fontSize: 12, color: '#666' }}>
          Progress: {completedEndpoints.length}/{totalEndpoints} endpoints
          <div style={{ height: 6, background: '#eee', borderRadius: 3, marginTop: 4 }}>
            <div
              style={{
                height: 6,
                width: `${Math.round(progress * 100)}%`,
                background: '#2e7d32',
                borderRadius: 3,
                transition: 'width 0.3s ease',
              }}
            />
          </div>
        </div>
      )}

      {isComplete && (
        <p style={{ padding: '0 16px', color: '#2e7d32', fontWeight: 600, fontSize: 14 }}>
          Intake complete — all endpoints submitted.
        </p>
      )}
      {error && (
        <p style={{ padding: '0 16px', color: '#c62828', fontSize: 14 }}>Error: {error.message}</p>
      )}

      <div
        style={{
          height: 320,
          overflowY: 'auto',
          padding: 16,
          background: '#fafafa',
          borderTop: '1px solid #eee',
          borderBottom: '1px solid #eee',
        }}
      >
        {messages.length === 0 && <p style={{ color: '#777', fontSize: 14 }}>Say hello to get started…</p>}
        {messages.map((message, i) => (
          <div
            key={i}
            style={{ textAlign: message.role === 'user' ? 'right' : 'left', margin: '8px 0' }}
          >
            <div
              style={{
                display: 'inline-block',
                maxWidth: '80%',
                padding: '8px 12px',
                borderRadius: 12,
                background: message.role === 'user' ? '#1976d2' : '#e0e0e0',
                color: message.role === 'user' ? '#fff' : '#111',
                whiteSpace: 'pre-wrap',
                fontSize: 14,
              }}
            >
              {message.content}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 8, padding: 12 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type your answer…"
          disabled={loading || isComplete}
          style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid #ccc', fontSize: 14 }}
        />
        <button
          type="submit"
          disabled={loading || isComplete || !draft.trim()}
          style={{
            padding: '8px 16px',
            borderRadius: 8,
            border: 'none',
            background: '#1976d2',
            color: '#fff',
            cursor: 'pointer',
            fontSize: 14,
          }}
        >
          {loading ? '…' : 'Send'}
        </button>
      </form>
    </div>
  );
}
