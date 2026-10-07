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
  const staleReason = currentEndpoint ? form.stepRecords[currentEndpoint.id]?.staleReason : undefined;
  const busy =
    form.editPhase !== 'idle' || form.currentStepStatus === 'validating' || form.currentStepStatus === 'executing';
  const submitLabel = form.isEditing
    ? form.editPhase === 'validating'
      ? 'Validating…'
      : form.editPhase === 'saving'
        ? 'Saving…'
        : form.editPhase === 'checking'
          ? 'Checking later steps…'
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
        <div className="agent-intake-form-complete">
          <p>All steps complete.</p>
          {form.followUps.length > 0 && (
            <div className="agent-intake-follow-ups">
              <p>These steps were accepted but need follow-up outside this form:</p>
              <ul>
                {form.followUps.map(({ endpointId, note }) => (
                  <li key={endpointId}>
                    <strong>{flow.endpoints.find((endpoint) => endpoint.id === endpointId)?.title}:</strong> {note}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <section className="agent-intake-step" aria-labelledby="agent-intake-step-title">
          <h2 id="agent-intake-step-title">{currentEndpoint.title}</h2>
          {currentEndpoint.description && <p>{currentEndpoint.description}</p>}
          {form.isEditing && (
            <p className="agent-intake-edit-notice">
              {form.currentStepStatus === 'stale'
                ? `${staleReason ?? 'An earlier answer changed.'} ${
                    form.staleResolution === 'mustEdit'
                      ? 'Its questions changed, so update it before continuing.'
                      : form.staleResolution === 'followUp'
                        ? "Its questions changed, but it can't be changed here."
                        : readOnly
                          ? "It can't be changed here; keep it if it still applies."
                          : 'Keep it as it is, or change it and save.'
                  }`
                : readOnly
                  ? "This step is already done and can't be changed here."
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

              {!readOnly && (
                <button type="submit" disabled={busy}>
                  {submitLabel}
                </button>
              )}
              {form.staleResolution === 'keepOrEdit' && (
                <button type="button" onClick={() => form.acknowledgeStale()} disabled={busy}>
                  Keep as is
                </button>
              )}
              {form.staleResolution === 'followUp' && (
                <button type="button" onClick={() => form.flagForFollowUp()} disabled={busy}>
                  Accept and flag for follow-up
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
