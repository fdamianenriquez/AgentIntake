import type { FlowDef } from './contracts.js';
import { useAgentForm, type UseAgentFormOptions } from './useAgentForm.js';
import { FieldControl } from './fieldControls/index.js';

export interface AgentIntakeFormProps extends UseAgentFormOptions {
  flow: FlowDef;
}

// A thin, replaceable consumer of useAgentForm -- all the
// actual state/lifecycle logic lives in the hook; this just renders it.
export function AgentIntakeForm({ flow, apiUrl, getAuthHeaders }: AgentIntakeFormProps) {
  const form = useAgentForm(flow, { apiUrl, getAuthHeaders });
  const currentEndpoint = flow.endpoints[form.currentStepIndex];

  if (form.error) {
    return (
      <p role="alert" className="agent-intake-fatal-error">
        {form.error.message}
      </p>
    );
  }

  return (
    <div className="agent-intake-form">
      <ol className="agent-intake-stepper">
        {flow.endpoints.map((endpoint, index) => {
          const status = form.completedEndpoints.includes(endpoint.id)
            ? 'complete'
            : index === form.currentStepIndex
              ? 'current'
              : 'pending';
          return (
            <li key={endpoint.id} data-status={status} aria-current={status === 'current' || undefined}>
              {status === 'complete' ? '✓ ' : ''}
              {endpoint.title}
            </li>
          );
        })}
      </ol>

      {form.isComplete || !currentEndpoint ? (
        <p className="agent-intake-form-complete">All steps complete.</p>
      ) : (
        <section className="agent-intake-step" aria-labelledby="agent-intake-step-title">
          <h2 id="agent-intake-step-title">{currentEndpoint.title}</h2>
          {currentEndpoint.description && <p>{currentEndpoint.description}</p>}

          {form.loading ? (
            <p role="status">Loading…</p>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void form.submitStep();
              }}
            >
              {form.currentStepFields.map((field) => (
                <FieldControl
                  key={field.name}
                  field={field}
                  value={form.values[field.name]}
                  onChange={(value) => form.updateField(field.name, value)}
                  error={form.errors[field.name]}
                  suggested={field.name in form.suggestedValues}
                />
              ))}

              {form.currentStepStatus === 'executionFailed' && (
                <div role="alert" className="agent-intake-execution-error">
                  <p>{form.executionError}</p>
                  <button type="button" onClick={() => void form.retryExecution()}>
                    Retry
                  </button>
                </div>
              )}

              <button
                type="submit"
                disabled={form.currentStepStatus === 'validating' || form.currentStepStatus === 'executing'}
              >
                {form.currentStepStatus === 'validating'
                  ? 'Validating…'
                  : form.currentStepStatus === 'executing'
                    ? 'Submitting…'
                    : 'Continue'}
              </button>
            </form>
          )}
        </section>
      )}
    </div>
  );
}
