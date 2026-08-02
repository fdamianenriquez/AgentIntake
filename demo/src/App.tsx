import { useEffect, useState } from 'react';
import { AgentChatUI } from 'react-agent-intake';

const API_BASE = 'http://localhost:4000';
const FLOW_ID = 'job_application_intake';

const ENDPOINT_LABELS: Record<string, string> = {
  submit_candidate_info: 'Candidate info',
  submit_work_preferences: 'Work preferences',
  submit_availability: 'Availability',
};

export default function App() {
  const [endpoints, setEndpoints] = useState<string[]>([]);

  useEffect(() => {
    fetch(`${API_BASE}/api/flows`)
      .then((res) => res.json())
      .then((flows: Array<{ id: string; endpoints: Array<{ id: string }> }>) => {
        const flow = flows.find((f) => f.id === FLOW_ID);
        if (flow) {
          setEndpoints(flow.endpoints.map((e) => e.id));
        }
      })
      .catch(() => {
        // Server not running yet — the checklist populates on the next load.
      });
  }, []);

  return (
    <main>
      <header>
        <h1>AgentIntake</h1>
        <p>
          A single conversation replaces a 3-page job application form. Each endpoint fires
          independently as soon as its fields are validated — watch the checklist tick off
          mid-conversation, and check the <code>server</code> console for the calls.
        </p>
      </header>
      <AgentChatUI
        apiUrl={`${API_BASE}/api/conversation`}
        flowId={FLOW_ID}
        title="Job Application Intake"
        description="Chat with the agent to submit your application — candidate info, work preferences, and availability."
        endpoints={endpoints}
        endpointLabels={ENDPOINT_LABELS}
      />
    </main>
  );
}
