import { AgentIntakeForm } from '../packages/react-agent-intake/src/index.js';
import type { FlowDef } from '../server/src/flowSchema.js';
import type { GenerateResponse } from './SpecInput.js';

export interface FlowPreviewProps {
  generation: GenerateResponse;
  onReset: () => void;
}

// Studio's preview runs operations in simulated mode -- Studio itself supplies
// this stand-in for every endpoint (unlike demo/App.tsx's real,
// non-simulated execute(), which the *flow author* writes deliberately),
// paired with the always-visible "Preview mode" notice below.
function makeSimulatedExecute(endpointId: string, endpointTitle: string) {
  return async (data: Record<string, unknown>) => {
    console.log(`[Preview mode] Would call the "${endpointTitle}" endpoint (${endpointId}) with:`, data);
    return { success: true, message: `${endpointTitle} (simulated).` };
  };
}

function downloadFlowJson(flow: unknown) {
  const blob = new Blob([JSON.stringify(flow, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'flow.json';
  anchor.click();
  URL.revokeObjectURL(url);
}

const EMBED_SNIPPET = `import { AgentIntakeForm } from 'react-agent-intake';
import flow from './flow.json';

// flow.json has no "execute" -- add a real one to each endpoint by hand
// before using this in a real app (see the exported file).

<AgentIntakeForm flow={flow} apiUrl="http://localhost:3000" />`;

export function FlowPreview({ generation, onReset }: FlowPreviewProps) {
  const flow: FlowDef = {
    ...generation.flow,
    endpoints: generation.flow.endpoints.map((endpoint) => ({
      ...endpoint,
      execute: makeSimulatedExecute(endpoint.id, endpoint.title),
    })),
  };

  return (
    <section className="studio-preview">
      <div role="status" className="studio-preview-banner">
        Preview mode -- each step's "execute" just logs to the browser console instead of hitting a real
        API.
      </div>

      {generation.warnings.length > 0 && (
        <ul className="studio-warnings">
          {generation.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      {/* apiUrl="" -- same origin: Studio's own server already mounts the
          shared /api/step/* routes, so this preview exercises the real
          adaptive-fields and semantic-validation calls, not just execute(). */}
      <AgentIntakeForm flow={flow} apiUrl="" />

      {generation.ambiguousFields.length > 0 && (
        <div className="studio-ambiguous-fields">
          <h3>Flagged for review</h3>
          <ul>
            {generation.ambiguousFields.map((note) => (
              <li key={`${note.endpointId}.${note.fieldName}`}>
                <strong>
                  {note.endpointId}.{note.fieldName}:
                </strong>{' '}
                {note.note}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="studio-export">
        <button type="button" onClick={() => downloadFlowJson(generation.flow)}>
          Download flow.json
        </button>
        <details>
          <summary>Embed snippet</summary>
          <pre>{EMBED_SNIPPET}</pre>
        </details>
      </div>

      <button type="button" onClick={onReset}>
        Start over
      </button>
    </section>
  );
}
