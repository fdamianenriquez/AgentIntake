import { useMemo, useState } from 'react';
import { AgentIntakeForm } from '../packages/react-agent-intake/src/index.js';
import type { FlowDef, GeneratedFlow, ResourceOperations } from '../packages/react-agent-intake/src/contracts.js';
import { cleanFlow, flowGuidanceProblems, Instructions, type InstructionsProps } from './Instructions.js';
import type { GenerateResponse } from './SpecInput.js';

export interface FlowPreviewProps {
  generation: GenerateResponse;
  /** Gets the flow as edited (with its guidance), so a regeneration can carry the guidance over. */
  onReset: (flow: GeneratedFlow) => void;
  /** Steps whose guidance a regeneration dropped, because they no longer exist. */
  droppedGuidance?: string[];
  timings?: InstructionsProps['timings'];
}

type GeneratedEndpoint = GenerateResponse['flow']['endpoints'][number];

// Studio's preview runs operations in simulated mode -- Studio itself supplies
// stand-ins (unlike demo/App.tsx's operations, which the *flow author* writes
// deliberately), paired with the always-visible "Preview mode" notice below.
// Besides create, every read/update/undo the parser found in the
// spec is simulated too, against an in-memory store, so revisiting and
// changing steps can be previewed. Nothing ever leaves the browser.
function makeSimulatedOperations(endpoint: GeneratedEndpoint, store: Map<string, Record<string, unknown>>): ResourceOperations {
  const name = `"${endpoint.title}" endpoint (${endpoint.id})`;
  const operations: ResourceOperations = {
    create: async (data) => {
      console.log(`[Preview mode] Would call the ${name} with:`, data);
      const resourceId = `sim-${endpoint.id}-${store.size + 1}`;
      store.set(resourceId, data);
      return { success: true, message: `${endpoint.title} (simulated).`, resourceId };
    },
  };
  if (endpoint.capabilities?.read) {
    operations.read = async ({ resourceId }) => {
      console.log(`[Preview mode] Would read ${resourceId} from the ${name}.`);
      const data = store.get(resourceId);
      return data ? { found: true, data } : { found: false };
    };
  }
  if (endpoint.capabilities?.update) {
    operations.update = async (data, { resourceId }) => {
      console.log(`[Preview mode] Would update ${resourceId} through the ${name} with:`, data);
      store.set(resourceId, { ...store.get(resourceId), ...data });
      return { success: true, resourceId };
    };
  }
  if (endpoint.capabilities?.undo) {
    operations.undo = async ({ resourceId }) => {
      console.log(`[Preview mode] Would undo ${resourceId} through the ${name}.`);
      store.delete(resourceId);
      return { success: true };
    };
  }
  return operations;
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

// flow.json has no functions -- give each endpoint an "execute", or
// "operations" (create, plus read/update/undo where the endpoint lists
// capabilities), before using this in a real app.

<AgentIntakeForm flow={flow} apiUrl="http://localhost:3000" />`;

type Tab = 'preview' | 'instructions';

export function FlowPreview({ generation, onReset, droppedGuidance = [], timings }: FlowPreviewProps) {
  const [store] = useState(() => new Map<string, Record<string, unknown>>());
  // The flow as the author edits it in the Instructions tab (flow and step
  // guidance); the preview and the download always use this version.
  const [edited, setEdited] = useState<GeneratedFlow>(generation.flow);
  const [tab, setTab] = useState<Tab>('preview');
  const sent = useMemo(() => cleanFlow(edited), [edited]);
  const problems = flowGuidanceProblems(edited);
  const flow: FlowDef = useMemo(
    () => ({
      ...sent,
      endpoints: sent.endpoints.map((endpoint) => ({
        ...endpoint,
        operations: makeSimulatedOperations(endpoint, store),
      })),
    }),
    [sent, store]
  );

  const tabButton = (id: Tab, label: string) => (
    <button
      type="button"
      role="tab"
      id={`studio-tab-${id}`}
      aria-selected={tab === id}
      aria-controls={`studio-panel-${id}`}
      onClick={() => setTab(id)}
    >
      {label}
    </button>
  );

  return (
    <section className="studio-preview">
      <div role="status" className="studio-preview-banner">
        Preview mode -- each step's operations (create, and read/update/undo where the API offers them) are simulated in memory and logged
        to the browser console instead of hitting a real API.
      </div>

      {generation.warnings.length > 0 && (
        <ul className="studio-warnings">
          {generation.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      {droppedGuidance.length > 0 && (
        <p role="status" className="studio-warnings">
          Guidance kept from the previous version of this flow, except for steps that no longer exist: {droppedGuidance.join(', ')}.
        </p>
      )}

      <div role="tablist" aria-label="Flow" className="studio-tabs">
        {tabButton('preview', 'Preview')}
        {tabButton('instructions', 'Instructions')}
      </div>

      {/* Both panels stay mounted, so switching tabs keeps the preview's progress. */}
      <div role="tabpanel" id="studio-panel-preview" aria-labelledby="studio-tab-preview" hidden={tab !== 'preview'}>
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
      </div>

      <div role="tabpanel" id="studio-panel-instructions" aria-labelledby="studio-tab-instructions" hidden={tab !== 'instructions'}>
        <Instructions flow={edited} onFlowChange={setEdited} timings={timings} />
      </div>

      <div className="studio-export">
        <button type="button" onClick={() => downloadFlowJson(sent)} disabled={problems.length > 0}>
          Download flow.json
        </button>
        {problems.length > 0 && <p className="studio-error">Fix the flow guidance before downloading: {problems.join(' ')}</p>}
        <details>
          <summary>Embed snippet</summary>
          <pre>{EMBED_SNIPPET}</pre>
        </details>
      </div>

      <button type="button" onClick={() => onReset(edited)}>
        Start over
      </button>
    </section>
  );
}
