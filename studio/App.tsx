import { useEffect, useState } from 'react';
import { ProviderSetup } from './ProviderSetup.js';
import { SpecInput, type GenerateResponse } from './SpecInput.js';
import { FlowPreview } from './FlowPreview.js';

type Screen = 'loading' | 'setup' | 'input' | 'preview';

interface ProviderStatusResponse {
  configured: boolean;
}

export function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [generation, setGeneration] = useState<GenerateResponse | null>(null);

  useEffect(() => {
    fetch('/api/provider-status')
      .then((response) => response.json() as Promise<ProviderStatusResponse>)
      .then((data) => setScreen(data.configured ? 'input' : 'setup'))
      .catch(() => setScreen('setup')); // fail safe: worst case, ask to (re-)configure
  }, []);

  return (
    <main className="studio-app">
      <h1>AgentIntake Studio</h1>
      <p className="studio-app-note">Paste in an OpenAPI spec and see a working wizard immediately.</p>

      {screen === 'loading' && <p role="status">Loading…</p>}

      {screen === 'setup' && <ProviderSetup onDone={() => setScreen('input')} />}

      {screen === 'input' && (
        <SpecInput
          onGenerated={(result) => {
            setGeneration(result);
            setScreen('preview');
          }}
        />
      )}

      {screen === 'preview' && generation && (
        <FlowPreview
          generation={generation}
          onReset={() => {
            setGeneration(null);
            setScreen('input');
          }}
        />
      )}
    </main>
  );
}
