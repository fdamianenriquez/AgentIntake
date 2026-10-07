import type { FlowDef } from './contracts.js';
import { useAgentForm, type UseAgentFormOptions } from './useAgentForm.js';
import { FieldControl } from './fieldControls/index.js';

export interface AgentIntakeFormProps extends UseAgentFormOptions {
  flow: FlowDef;
}

// A thin, replaceable consumer of useAgentForm -- all the
// actual state/lifecycle logic lives in the hook; this just renders it.
export function AgentIntakeForm({ flow, apiUrl, getAuthHeaders, recovery, onRecoveryEvent }: AgentIntakeFormProps) {
  const form = useAgentForm(flow, { apiUrl, getAuthHeaders, recovery, onRecoveryEvent });
  const titleOf = (endpointId: string) => flow.endpoints.find((endpoint) => endpoint.id === endpointId)?.title ?? endpointId;
  const titlesOf = (ids: string[] | undefined) => (ids ?? []).map(titleOf).join(', ');
  const currentEndpoint = flow.endpoints[form.currentStepIndex];

  if (form.error) {
    return (
      <p role="alert" className="agent-intake-fatal-error">
        {form.error.message}
      </p>
    );
  }

  const readOnly = form.editMode === 'readOnly';
  const rec = form.recovery;
  const recoveryHere = currentEndpoint !== undefined && rec.endpointId === currentEndpoint.id;
  const recoveryBusy = rec.phase === 'proposed' || rec.phase === 'rollingBack' || rec.phase === 'rollbackFailed';
  const staleReason = currentEndpoint ? form.stepRecords[currentEndpoint.id]?.staleReason : undefined;
  const busy =
    form.navigating ||
    form.editPhase !== 'idle' ||
    form.currentStepStatus === 'validating' ||
    form.currentStepStatus === 'executing';
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

      {rec.phase === 'rolledBack' && rec.report && (
        <div role="status" className="agent-intake-rollback-report">
          <p>Undone: {titlesOf(rec.report.undone)}. You can start again from here.</p>
          {rec.report.skipped.length > 0 && <p>Needs manual cleanup: {titlesOf(rec.report.skipped)}.</p>}
        </div>
      )}
      {rec.phase === 'rollbackFailed' && rec.report?.failed && (
        <div role="alert" className="agent-intake-rollback-report">
          <p>
            Couldn't undo {titleOf(rec.report.failed.endpointId)}
            {rec.report.failed.message ? `: ${rec.report.failed.message}` : '.'}
            {rec.report.undone.length > 0 ? ` Already undone: ${titlesOf(rec.report.undone)}.` : ''}
          </p>
          <button type="button" onClick={() => void form.retryRollback()}>
            Try the undo again
          </button>
        </div>
      )}

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
                  {recoveryHere && rec.phase === 'classifying' && (
                    <p className="agent-intake-recovery-status">Checking what went wrong…</p>
                  )}
                  {recoveryHere && rec.explanation && <p className="agent-intake-recovery-explanation">{rec.explanation}</p>}
                  {recoveryHere && rec.phase === 'proposed' && (
                    <div className="agent-intake-recovery-proposal">
                      <p>Undo what these completed steps created? Nothing is undone unless you confirm.</p>
                      <ul>
                        {rec.proposedUndo?.map((step) => (
                          <li key={step.endpointId}>{step.label}</li>
                        ))}
                      </ul>
                      {(rec.skipped?.length ?? 0) > 0 && (
                        <p>Can't be undone here (needs manual cleanup): {titlesOf(rec.skipped)}.</p>
                      )}
                      <button type="button" onClick={() => void form.confirmRollback()}>
                        Undo these steps
                      </button>
                      <button type="button" onClick={() => form.declineRollback()}>
                        Keep everything
                      </button>
                    </div>
                  )}
                  {recoveryHere && rec.phase === 'rollingBack' && <p className="agent-intake-recovery-status">Undoing…</p>}
                  {!form.isEditing && !recoveryBusy && rec.phase !== 'classifying' && (
                    <button type="button" onClick={() => void form.retryExecution()}>
                      Retry
                    </button>
                  )}
                </div>
              )}

              {!readOnly && (
                <button type="submit" disabled={busy || recoveryBusy}>
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
