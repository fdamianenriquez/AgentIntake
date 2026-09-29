import { useState, type FormEvent } from 'react';
import { SUPPORTED_PROVIDERS, type LlmProvider } from '../server/src/llmClient.js';

export interface ProviderSetupProps {
  onDone: () => void;
}

// Studio's audience explicitly includes non-technical users
// who shouldn't be expected to hand-edit .env. Shown once, before spec
// generation is allowed, whenever no provider + key is already configured.
export function ProviderSetup({ onDone }: ProviderSetupProps) {
  const [provider, setProvider] = useState<LlmProvider>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch('/api/provider-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `Setup failed (${response.status}).`);
      }

      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="studio-setup">
      <h2>Set up your LLM provider</h2>
      <p>
        AgentIntake needs an LLM provider to generate and adapt your wizard. Pick one and paste an API
        key -- it's saved to this project's local <code>.env</code> file so you won't need to re-enter it
        next time, and it's never sent anywhere but that provider.
      </p>
      <form onSubmit={handleSubmit}>
        <label htmlFor="provider">Provider</label>
        <select id="provider" value={provider} onChange={(event) => setProvider(event.target.value as LlmProvider)}>
          {SUPPORTED_PROVIDERS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>

        <label htmlFor="apiKey">API key</label>
        <input
          id="apiKey"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          required
        />

        {error && (
          <p role="alert" className="studio-error">
            {error}
          </p>
        )}

        <button type="submit" disabled={submitting || apiKey.trim().length === 0}>
          {submitting ? 'Saving…' : 'Save and continue'}
        </button>
      </form>
    </section>
  );
}
