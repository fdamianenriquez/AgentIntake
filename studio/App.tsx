import { useEffect, useState } from 'react';
import { ProviderSetup } from './ProviderSetup.js';
import { SpecInput, type GenerateResponse } from './SpecInput.js';
import { FlowPreview } from './FlowPreview.js';
import { carryOverGuidance } from './carryOver.js';
import type { GeneratedFlow } from '../packages/react-agent-intake/src/contracts.js';

type Screen = 'loading' | 'setup' | 'input' | 'preview';

interface ProviderStatusResponse {
  configured: boolean;
}

export function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [generation, setGeneration] = useState<GenerateResponse | null>(null);
  // The last flow of this session, as edited, so a regeneration keeps its guidance.
  const [previousFlow, setPreviousFlow] = useState<GeneratedFlow | null>(null);
  const [droppedGuidance, setDroppedGuidance] = useState<string[]>([]);

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
            if (previousFlow) {
              const { flow, droppedSteps } = carryOverGuidance(previousFlow, result.flow);
              setGeneration({ ...result, flow });
              setDroppedGuidance(droppedSteps);
            } else {
              setGeneration(result);
              setDroppedGuidance([]);
            }
            setScreen('preview');
          }}
        />
      )}

      {screen === 'preview' && generation && (
        <FlowPreview
          generation={generation}
          droppedGuidance={droppedGuidance}
          onReset={(edited) => {
            setPreviousFlow(edited);
            setGeneration(null);
            setScreen('input');
          }}
        />
      )}
    </main>
  );
}
