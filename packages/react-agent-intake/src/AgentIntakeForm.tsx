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

  const readOnly = form.editMode === 'readOnly';
  const staleReadOnly = readOnly && form.currentStepStatus === 'stale';
  const busy =
    form.editPhase !== 'idle' || form.currentStepStatus === 'validating' || form.currentStepStatus === 'executing';
  const submitLabel = form.isEditing
    ? form.editPhase === 'validating'
      ? 'Validating…'
      : form.editPhase === 'saving'
        ? 'Saving…'
        : staleReadOnly
          ? 'Confirm'
          : 'Save changes'
    : form.currentStepStatus === 'validating'
      ? 'Validating…'
      : form.currentStepStatus === 'executing'
        ? 'Submitting…'
        : 'Continue';

  return (
    <div className="agent-intake-form">
      <ol className="agent-intake-stepper">
        {flow.endpoints.map((endpoint, index) => {
          const recorded = form.stepRecords[endpoint.id]?.status;
          // Once everything is done (and nothing is being revisited), no step is "current".
          const isCurrent = index === form.currentStepIndex && !(form.isComplete && !form.isEditing);
          const status = isCurrent
              ? 'current'
              : recorded === 'complete'
                ? 'complete'
                : recorded === 'stale'
                  ? 'stale'
                  : 'pending';
          const label = (
            <>
              {status === 'complete' ? '✓ ' : ''}
              {endpoint.title}
              {recorded === 'stale' ? ' (needs review)' : ''}
            </>
          );
          return (
            <li key={endpoint.id} data-status={status} aria-current={status === 'current' || undefined}>
              {form.canGoToStep(endpoint.id) ? (
                <button type="button" className="agent-intake-stepper-link" onClick={() => void form.goToStep(endpoint.id)}>
                  {label}
                </button>
              ) : (
                label
              )}
            </li>
          );
        })}
      </ol>

      {form.navigationError && (
        <p role="alert" className="agent-intake-navigation-error">
          {form.navigationError}
        </p>
      )}

      {(form.isComplete && !form.isEditing) || !currentEndpoint ? (
        <p className="agent-intake-form-complete">All steps complete.</p>
      ) : (
        <section className="agent-intake-step" aria-labelledby="agent-intake-step-title">
          <h2 id="agent-intake-step-title">{currentEndpoint.title}</h2>
          {currentEndpoint.description && <p>{currentEndpoint.description}</p>}
          {form.isEditing && (
            <p className="agent-intake-edit-notice">
              {staleReadOnly
                ? "An earlier answer changed. This step can't be changed here -- confirm it still applies."
                : readOnly
                ? "This step is already done and can't be changed here."
                : form.currentStepStatus === 'stale'
                  ? 'An earlier answer changed. Check this step and save it again.'
                  : "You're changing a step you already completed."}
            </p>
          )}

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
                  disabled={readOnly}
                />
              ))}

              {(form.currentStepStatus === 'executionFailed' || (form.isEditing && form.executionError)) && (
                <div role="alert" className="agent-intake-execution-error">
                  <p>{form.executionError}</p>
                  {!form.isEditing && (
                    <button type="button" onClick={() => void form.retryExecution()}>
                      Retry
                    </button>
                  )}
                </div>
              )}

              {(!readOnly || staleReadOnly) && (
                <button type="submit" disabled={busy}>
                  {submitLabel}
                </button>
              )}
              {form.isEditing && (
                <button type="button" onClick={() => form.cancelEdit()} disabled={busy}>
                  {readOnly ? 'Back' : 'Cancel'}
                </button>
              )}
            </form>
          )}
        </section>
      )}
    </div>
  );
}
