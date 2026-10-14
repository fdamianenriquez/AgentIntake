import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { EndpointDef, ExecContext, FieldDef, FlowDef, OperationResult } from './contracts.js';
import { implementedCapabilities, normalizeResult, operationsOf, resultFromError } from './operations.js';
import {
  preClassify,
  type FailureClassification,
  type RecoveryEvent,
  type RollbackReport,
} from './recovery.js';

// StepStatus (README: "The `StepStatus` lifecycle") is the single source of truth for a step's
// lifecycle -- never inferred from separate booleans. 'complete' is
// reserved exclusively for a successful create; a step that only passed
// semantic validation is 'executing' or 'executionFailed', never 'complete'.
// 'stale' is a step that was complete, but an earlier step
// changed since, so the user has to look at it again.
export type StepStatus = 'idle' | 'validating' | 'invalid' | 'executing' | 'complete' | 'executionFailed' | 'stale';

/** What the hook remembers about each step, kept after the user moves on. */
export interface StepRecord {
  endpointId: string;
  /** The last values submitted for this step. */
  values: Record<string, unknown>;
  /** The last create/update result, including `resourceId` when the author returned one. */
  result?: OperationResult;
  status: StepStatus;
  /** The fields that were shown when the step was last submitted. */
  fieldNames?: string[];
  /** Why the step needs review, while `status` is 'stale'. */
  staleReason?: string;
  /**
   * Set when the step was accepted although it no longer fits (an earlier
   * answer changed its fields, and it can't be changed here). Needs handling
   * outside the wizard.
   */
  followUp?: string;
}

/**
 * What the user can do with the stale step being shown:
 * keep it as it is, change it (its fields changed, so keeping is refused), or,
 * when it can't be changed here, accept it and flag it for follow-up.
 */
export type StaleResolution = 'keepOrEdit' | 'mustEdit' | 'followUp';

/**
 * When revisiting a completed step: `editable` when the author implemented
 * `update` and create returned a `resourceId`, otherwise `readOnly` (the step
 * can be looked at but not changed). See README: "Revisiting completed steps".
 */
export type EditMode = 'editable' | 'readOnly';
export type EditPhase = 'idle' | 'validating' | 'saving' | 'checking';

export type RecoveryPhase = 'idle' | 'classifying' | 'proposed' | 'rollingBack' | 'rolledBack' | 'rollbackFailed';

/** What is known about the last failed step, and any undo proposed for it. */
export interface RecoveryView {
  phase: RecoveryPhase;
  /** The step whose create failed. */
  endpointId?: string;
  classification?: FailureClassification;
  explanation?: string;
  /** The steps that would be undone, in the order the undo runs. */
  proposedUndo?: { endpointId: string; label: string }[];
  /** Steps in the undo range with no usable undo; they need manual cleanup. */
  skipped?: string[];
  report?: RollbackReport;
}

export interface UseAgentFormOptions {
  apiUrl: string;
  // The direct-from-browser auth pattern (README: "Authentication model"):
  // flows into each operation's context. May be async (e.g. refreshing a token).
  getAuthHeaders?: () => Promise<Record<string, string>> | Record<string, string>;
  // 'confirm' (default): a fundamental failure may propose undoing earlier
  // steps, which only runs after the user confirms. 'off': never propose.
  // There is deliberately no automatic mode.
  recovery?: { rollback?: 'confirm' | 'off' };
  /** For host-app logging/analytics. */
  onRecoveryEvent?: (event: RecoveryEvent) => void;
}

export interface UseAgentFormResult {
  currentStepIndex: number;
  totalSteps: number;
  currentStepFields: FieldDef[];
  suggestedValues: Record<string, unknown>;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  currentStepStatus: StepStatus;
  executionError: string | null;
  // A distinct signal for "fetching this step's adapted fields,"
  // which currentStepStatus (about submitStep(), not step entry) doesn't cover.
  loading: boolean;
  updateField: (fieldName: string, value: unknown) => void;
  submitStep: () => Promise<void>;
  retryExecution: () => Promise<void>;
  completedEndpoints: string[];
  isComplete: boolean;
  stepRecords: Record<string, StepRecord>;
  /** Whether `goToStep(endpointId)` would currently be allowed. */
  canGoToStep: (endpointId: string) => boolean;
  /** Revisit a completed (or stale) step. Resolves once the step is shown, or an error is set. */
  goToStep: (endpointId: string) => Promise<void>;
  /** Leave the step being revisited without changing it. */
  cancelEdit: () => void;
  /** For the stale step being shown: keep it as it is. Refused when its fields changed. */
  acknowledgeStale: () => { ok: true } | { ok: false; reason: 'fieldsChanged' | 'notStale' };
  /** For a stale step that can't be changed here and whose fields changed: accept it, flagged for follow-up. */
  flagForFollowUp: () => void;
  /** How the stale step being shown can be resolved; null when no stale step is shown. */
  staleResolution: StaleResolution | null;
  /** Steps accepted with a follow-up note. */
  followUps: { endpointId: string; note: string }[];
  isEditing: boolean;
  editMode: EditMode | null;
  editPhase: EditPhase;
  /** Set when revisiting a step failed (e.g. its `read` threw); the user stays where they were. */
  navigationError: string | null;
  /** True while a step is being opened for review (its read is in flight); submitting is disabled meanwhile. */
  navigating: boolean;
  recovery: RecoveryView;
  /** Run the proposed undo, in reverse order, stopping at the first failure. */
  confirmRollback: () => Promise<void>;
  /** Keep everything as it is; the user can still retry or change their answers. */
  declineRollback: () => void;
  /** After a failed undo, continue from the step that failed. */
  retryRollback: () => Promise<void>;
  error: Error | null;
}

interface StepFieldsResponse {
  fields: FieldDef[];
  suggestedValues: Record<string, unknown>;
  degraded: boolean;
}

interface StepValidateResponse {
  valid: boolean;
  errors: Record<string, string>;
  degraded: boolean;
}

// Functions never go over the wire; the server only learns which operations
// exist, as booleans.
// The flow's id and author settings, sent with each runtime call (the server
// holds no flow definitions of its own, unless it runs with trusted flows).
function toWireFlow(flow: FlowDef) {
  return {
    id: flow.id,
    ...(flow.guidance !== undefined ? { guidance: flow.guidance } : {}),
    ...(flow.outputLanguage !== undefined ? { outputLanguage: flow.outputLanguage } : {}),
  };
}

function toWireEndpoint(endpoint: EndpointDef) {
  const { execute: _execute, operations: _operations, ...rest } = endpoint;
  return { ...rest, capabilities: implementedCapabilities(endpoint) };
}

// crypto.randomUUID only exists in secure contexts (HTTPS or localhost);
// getRandomValues is available everywhere, so a plain-HTTP deployment still works.
function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const isEmptyValue = (value: unknown) => value === undefined || value === null || value === '';

// Fast, local checks per FieldDef, before any network call -- not a
// replacement for server-side semantic validation, just enough to
// avoid a round-trip for obviously-missing/malformed input.
function validateClientSide(fields: FieldDef[], values: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {};

  for (const field of fields) {
    const value = values[field.name];
    const isEmpty = isEmptyValue(value);

    if (field.required && isEmpty) {
      errors[field.name] = `${field.label} is required.`;
      continue;
    }
    if (isEmpty) continue;

    if (field.type === 'enum') {
      if (field.enumValues && !field.enumValues.includes(String(value))) {
        errors[field.name] = `${field.label} must be one of: ${field.enumValues.join(', ')}.`;
      }
      continue;
    }

    if (field.type === 'number') {
      const num = typeof value === 'number' ? value : Number(value);
      if (Number.isNaN(num)) {
        errors[field.name] = `${field.label} must be a number.`;
      } else if (field.validation?.min !== undefined && num < field.validation.min) {
        errors[field.name] = `${field.label} must be at least ${field.validation.min}.`;
      } else if (field.validation?.max !== undefined && num > field.validation.max) {
        errors[field.name] = `${field.label} must be at most ${field.validation.max}.`;
      }
      continue;
    }

    if (field.type === 'string' && field.validation?.pattern) {
      if (!new RegExp(field.validation.pattern).test(String(value))) {
        errors[field.name] = `${field.label} is not in the expected format.`;
      }
    }
  }

  return errors;
}

// On revisit, only the fields the current adaptation shows are
// submitted (the previous values travel separately as ctx.previousValues).
function visibleValues(fields: FieldDef[], values: Record<string, unknown>): Record<string, unknown> {
  const visible: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.name in values) visible[field.name] = values[field.name];
  }
  return visible;
}

function sameFieldSet(fields: FieldDef[], recorded: string[] | undefined): boolean {
  if (!recorded) return true;
  const names = new Set(fields.map((field) => field.name));
  return names.size === recorded.length && recorded.every((name) => names.has(name));
}

// "Unchanged" means: the same fields are shown as last time, every one has the
// same value, and nothing that was filled in last time is now hidden.
function isUnchanged(
  fields: FieldDef[],
  values: Record<string, unknown>,
  previous: Record<string, unknown>,
  recordedFieldNames: string[] | undefined
): boolean {
  if (!sameFieldSet(fields, recordedFieldNames)) return false;
  const visible = new Set(fields.map((field) => field.name));
  for (const field of fields) {
    const now = values[field.name];
    const before = previous[field.name];
    if (!(isEmptyValue(now) && isEmptyValue(before)) && now !== before) return false;
  }
  return Object.entries(previous).every(([name, value]) => visible.has(name) || isEmptyValue(value));
}

// Read data merged over the local record, field by field: a field read
// provides wins, a field it doesn't (a write-only secret, something the API
// omits) keeps its local value. Only the step's own fields count -- all of
// them, shown or not -- so read's metadata (id, status, timestamps...) never
// gets in.
function readOverLocal(
  endpoint: EndpointDef,
  local: Record<string, unknown>,
  data: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const field of endpoint.fields) {
    const found = valueAt(data, field.name);
    if (found.present) merged[field.name] = found.value;
    else if (field.name in local) merged[field.name] = local[field.name];
  }
  return merged;
}

// The parser flattens request bodies to dotted names ("address.city"), while
// a GET usually answers { address: { city } }. A flat key wins if both exist.
function valueAt(data: Record<string, unknown>, name: string): { present: boolean; value?: unknown } {
  if (Object.prototype.hasOwnProperty.call(data, name)) return { present: true, value: data[name] };
  if (!name.includes('.')) return { present: false };
  let current: unknown = data;
  for (const part of name.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return { present: false };
    if (!Object.prototype.hasOwnProperty.call(current, part)) return { present: false };
    current = (current as Record<string, unknown>)[part];
  }
  return { present: true, value: current };
}

function sameValues(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => a[key] === b[key] || (isEmptyValue(a[key]) && isEmptyValue(b[key])));
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`${new URL(url, 'http://x').pathname} responded with ${response.status}`);
  return response.json();
}

// ---------------------------------------------------------------------------
// State: one reducer, so combinations the StepStatus machine forbids can't be
// represented by separately-updated pieces of state.
// ---------------------------------------------------------------------------

interface Draft {
  endpointId: string;
  values: Record<string, unknown>;
}

function withDraft(drafts: Record<string, Record<string, unknown>>, draft: Draft | null) {
  return draft ? { ...drafts, [draft.endpointId]: draft.values } : drafts;
}

interface Editing {
  endpointId: string;
  /** Where to go back to on cancel. */
  returnIndex: number;
  mode: EditMode;
  phase: EditPhase;
  /**
   * What the form was prefilled with: the server's data when the step has
   * read, otherwise the local record. "Unchanged", previousValues and the
   * invalidation check's "before" are all judged against this.
   */
  baseline: Record<string, unknown>;
}

interface FormState {
  currentStepIndex: number;
  currentStepFields: FieldDef[];
  suggestedValues: Record<string, unknown>;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  executionError: string | null;
  loading: boolean;
  error: Error | null;
  records: Record<string, StepRecord>;
  /** Per endpoint: the key for the create/update currently being attempted. */
  idempotencyKeys: Record<string, string>;
  editing: Editing | null;
  /** Values to show when a step is next entered (server data, the local record, or a draft). */
  prefill: { endpointId: string; values: Record<string, unknown> } | null;
  /** What the user had typed on an unfinished step before going back to an earlier one. */
  drafts: Record<string, Record<string, unknown>>;
  navigationError: string | null;
  /** A stale step the wizard has to open in edit mode next (it can't just be re-created). */
  pendingRevisit: string | null;
  /**
   * Where cancel should return to once the stale step queued in
   * `pendingRevisit` opens: the user's position before the edit that
   * started this chain of reviews, not the step that was just edited.
   */
  pendingReturnIndex: number | null;
  navigating: boolean;
  recovery: RecoveryState;
  /** Per endpoint: failures without a known cause so far (the first is retried before asking the model). */
  otherFailures: Record<string, number>;
}

interface RecoveryState extends RecoveryView {
  /** Where the flow resumes after a rollback. */
  anchorId?: string;
  /** Undos still to run, in order. */
  pending?: string[];
}

const IDLE_RECOVERY: RecoveryState = { phase: 'idle' };

// While a failure is being classified, or an undo is proposed, running, or
// stopped on a failure, nothing else may move the flow: a navigation or submit
// would act on resources the undo is about to remove (or has partly removed),
// or let the flow move on before a verdict about it arrives.
function recoveryLocked(state: FormState): boolean {
  const { phase } = state.recovery;
  return phase === 'classifying' || phase === 'proposed' || phase === 'rollingBack' || phase === 'rollbackFailed';
}

type FormAction =
  | { type: 'fatal'; error: Error }
  | { type: 'stepEntered'; endpointId: string; fields: FieldDef[] }
  | { type: 'fieldsLoaded'; fields: FieldDef[]; suggestedValues: Record<string, unknown> }
  | { type: 'fieldsFellBack'; fields: FieldDef[] }
  | { type: 'fieldUpdated'; endpointId: string; name: string; value: unknown }
  | { type: 'clientInvalid'; endpointId: string; errors: Record<string, string> }
  | { type: 'validating'; endpointId: string }
  | { type: 'serverInvalid'; endpointId: string; errors: Record<string, string> }
  | { type: 'executing'; endpointId: string; idempotencyKey: string }
  | {
      type: 'createSucceeded';
      endpointId: string;
      values: Record<string, unknown>;
      fieldNames: string[];
      result: OperationResult;
      endpointIds: string[];
    }
  | { type: 'createFailed'; endpointId: string; values: Record<string, unknown>; result: OperationResult }
  | { type: 'navigationStarted' }
  | { type: 'navigationFailed'; message: string }
  | {
      type: 'editStarted';
      endpointId: string;
      targetIndex: number;
      mode: EditMode;
      prefill: Record<string, unknown>;
      draft: Draft | null;
    }
  | { type: 'resourceMissing'; endpointId: string; targetIndex: number; endpointIds: string[]; draft: Draft | null }
  | { type: 'editPhase'; phase: EditPhase; idempotencyKey?: string }
  | { type: 'editInvalid'; errors: Record<string, string> }
  | { type: 'editFailed'; message: string }
  | {
      type: 'editSaved';
      values: Record<string, unknown>;
      fieldNames: string[];
      result: OperationResult;
      stale: { endpointId: string; reason: string }[];
      endpointIds: string[];
    }
  | { type: 'staleAccepted'; followUp?: string; endpointIds: string[] }
  | { type: 'editUnchanged'; endpointIds: string[]; values?: Record<string, unknown> }
  | { type: 'editCancelled'; endpointIds: string[] }
  | { type: 'otherFailureCounted'; endpointId: string }
  | { type: 'recoveryClassifying'; endpointId: string }
  | { type: 'classificationDropped'; endpointId: string }
  | { type: 'recoveryClassified'; endpointId: string; classification: FailureClassification; explanation?: string }
  | {
      type: 'recoveryProposed';
      endpointId: string;
      explanation: string;
      anchorId: string;
      undo: { endpointId: string; label: string }[];
      skipped: string[];
    }
  | { type: 'recoveryDeclined' }
  | { type: 'rollbackStarted' }
  | { type: 'undoSucceeded'; endpointId: string }
  | { type: 'undoFailed'; endpointId: string; result: OperationResult }
  | { type: 'rollbackFinished'; endpointIds: string[] };

const initialState: FormState = {
  currentStepIndex: 0,
  currentStepFields: [],
  suggestedValues: {},
  values: {},
  errors: {},
  executionError: null,
  loading: false,
  error: null,
  records: {},
  idempotencyKeys: {},
  editing: null,
  prefill: null,
  drafts: {},
  navigationError: null,
  pendingRevisit: null,
  pendingReturnIndex: null,
  navigating: false,
  recovery: IDLE_RECOVERY,
  otherFailures: {},
};

function withStatus(
  records: Record<string, StepRecord>,
  endpointId: string,
  status: StepStatus,
  patch: Partial<StepRecord> = {}
): Record<string, StepRecord> {
  const previous = records[endpointId] ?? { endpointId, values: {}, status: 'idle' as StepStatus };
  return { ...records, [endpointId]: { ...previous, ...patch, status } };
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

const SKIPPED_BY_ROLLBACK_REASON =
  'A step it depends on was undone and this one could not be undone automatically.';

const SAFE_SIDE_STALE_REASON = 'An earlier answer changed; check that this step still applies.';

// The safe side of cross-step invalidation: when it can't be narrowed down which later
// steps a change affects, every later completed step is flagged.
function laterCompletedIds(records: Record<string, StepRecord>, endpointIds: string[], editedId: string): string[] {
  return endpointIds.slice(endpointIds.indexOf(editedId) + 1).filter((id) => records[id]?.status === 'complete');
}

function markStale(records: Record<string, StepRecord>, stale: { endpointId: string; reason: string }[]) {
  let next = records;
  for (const { endpointId, reason } of stale) {
    if (next[endpointId]?.status === 'complete') next = withStatus(next, endpointId, 'stale', { staleReason: reason });
  }
  return next;
}

// Go to the first stale step if there is one, else the first
// step that isn't complete. A stale step can't simply be shown and re-submitted
// (that would call create again for a resource that exists), so it is handed to
// goToStep via `pendingRevisit` instead.
function advance(state: FormState, records: Record<string, StepRecord>, endpointIds: string[]): Partial<FormState> {
  const stale = endpointIds.find((id) => records[id]?.status === 'stale');
  if (stale) return { pendingRevisit: stale };
  const next = endpointIds.findIndex((id) => records[id]?.status !== 'complete');
  return { currentStepIndex: next === -1 ? state.currentStepIndex : next, pendingRevisit: null };
}

// advance(), remembering where the user was when a review gets queued, so that
// cancelling that review returns there.
function advanceKeepingReturn(state: FormState, records: Record<string, StepRecord>, endpointIds: string[]) {
  const next = advance(state, records, endpointIds);
  return { ...next, pendingReturnIndex: next.pendingRevisit ? state.editing?.returnIndex ?? null : null };
}

function reducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'fatal':
      return { ...state, error: action.error };
    case 'stepEntered': {
      const restored =
        state.prefill?.endpointId === action.endpointId ? state.prefill.values : state.drafts[action.endpointId] ?? {};
      return {
        ...state,
        loading: true,
        errors: {},
        executionError: null,
        suggestedValues: {},
        values: restored,
        currentStepFields: action.fields,
        prefill: null,
        drafts: withoutKey(state.drafts, action.endpointId),
      };
    }
    case 'fieldsLoaded':
      // Suggestions only fill a blank form; they never override what the user
      // (or the server, on a revisit) already provided.
      if (state.editing) return { ...state, loading: false, currentStepFields: action.fields, suggestedValues: {} };
      return {
        ...state,
        loading: false,
        currentStepFields: action.fields,
        suggestedValues: action.suggestedValues,
        values: { ...action.suggestedValues, ...state.values },
      };
    case 'fieldsFellBack':
      return { ...state, loading: false, currentStepFields: action.fields, suggestedValues: {} };
    case 'fieldUpdated': {
      const status = state.records[action.endpointId]?.status ?? 'idle';
      const reopen = !state.editing && (status === 'invalid' || status === 'executionFailed');
      return {
        ...state,
        values: { ...state.values, [action.name]: action.value },
        errors: reopen || state.editing ? {} : state.errors,
        executionError: reopen || state.editing ? null : state.executionError,
        records: reopen ? withStatus(state.records, action.endpointId, 'idle') : state.records,
        // New values make it a different logical operation.
        idempotencyKeys: withoutKey(state.idempotencyKeys, action.endpointId),
        recovery:
          state.recovery.endpointId === action.endpointId && state.recovery.phase === 'idle' ? IDLE_RECOVERY : state.recovery,
      };
    }
    case 'clientInvalid':
      return { ...state, errors: action.errors, records: withStatus(state.records, action.endpointId, 'invalid') };
    case 'validating':
      return { ...state, errors: {}, records: withStatus(state.records, action.endpointId, 'validating') };
    case 'serverInvalid':
      return { ...state, errors: action.errors, records: withStatus(state.records, action.endpointId, 'invalid') };
    case 'executing':
      return {
        ...state,
        executionError: null,
        records: withStatus(state.records, action.endpointId, 'executing'),
        idempotencyKeys: { ...state.idempotencyKeys, [action.endpointId]: action.idempotencyKey },
      };
    case 'createSucceeded': {
      const records = withStatus(state.records, action.endpointId, 'complete', {
        values: action.values,
        fieldNames: action.fieldNames,
        result: action.result,
      });
      return {
        ...state,
        records,
        idempotencyKeys: withoutKey(state.idempotencyKeys, action.endpointId),
        recovery: IDLE_RECOVERY,
        otherFailures: withoutKey(state.otherFailures, action.endpointId),
        ...advance(state, records, action.endpointIds),
      };
    }
    case 'createFailed':
      return {
        ...state,
        executionError: action.result.message ?? 'execute() reported failure.',
        records: withStatus(state.records, action.endpointId, 'executionFailed', {
          values: action.values,
          result: action.result,
        }),
      };
    case 'navigationStarted':
      return { ...state, navigationError: null, pendingRevisit: null, navigating: true };
    case 'navigationFailed':
      return { ...state, navigationError: action.message, navigating: false };
    case 'editStarted':
      return {
        ...state,
        navigating: false,
        editing: {
          endpointId: action.endpointId,
          returnIndex: state.editing?.returnIndex ?? state.pendingReturnIndex ?? state.currentStepIndex,
          mode: action.mode,
          phase: 'idle',
          baseline: action.prefill,
        },
        prefill: { endpointId: action.endpointId, values: action.prefill },
        drafts: withDraft(state.drafts, action.draft),
        currentStepIndex: action.targetIndex,
        pendingReturnIndex: null,
      };
    case 'resourceMissing': {
      // The resource is gone (read found nothing), so this step has to be created
      // again (from the local record) and everything after it re-checked.
      const record = state.records[action.endpointId];
      const { resourceId: _gone, ...result } = record?.result ?? { success: true };
      let records = withStatus(state.records, action.endpointId, 'idle', { result });
      records = markStale(
        records,
        laterCompletedIds(records, action.endpointIds, action.endpointId).map((endpointId) => ({
          endpointId,
          reason: 'A step this one builds on has to be submitted again.',
        }))
      );
      return {
        ...state,
        records,
        editing: null,
        navigating: false,
        prefill: { endpointId: action.endpointId, values: record?.values ?? {} },
        drafts: withDraft(state.drafts, action.draft),
        currentStepIndex: action.targetIndex,
      };
    }
    case 'editPhase':
      if (!state.editing) return state;
      return {
        ...state,
        errors: action.phase === 'validating' ? {} : state.errors,
        executionError: action.phase === 'idle' ? state.executionError : null,
        editing: { ...state.editing, phase: action.phase },
        idempotencyKeys: action.idempotencyKey
          ? { ...state.idempotencyKeys, [state.editing.endpointId]: action.idempotencyKey }
          : state.idempotencyKeys,
      };
    case 'editInvalid':
      if (!state.editing) return state;
      return { ...state, errors: action.errors, editing: { ...state.editing, phase: 'idle' } };
    case 'editFailed':
      // A failed update never rolls anything back -- the
      // resource is still there in its previous, valid state.
      if (!state.editing) return state;
      return { ...state, executionError: action.message, editing: { ...state.editing, phase: 'idle' } };
    case 'editSaved': {
      if (!state.editing) return state;
      const id = state.editing.endpointId;
      const previousId = state.records[id]?.result?.resourceId;
      let records = withStatus(state.records, id, 'complete', {
        values: action.values,
        fieldNames: action.fieldNames,
        result: { ...action.result, resourceId: action.result.resourceId ?? previousId },
        staleReason: undefined,
      });
      records = markStale(records, action.stale);
      return {
        ...state,
        records,
        editing: null,
        idempotencyKeys: withoutKey(state.idempotencyKeys, id),
        ...advanceKeepingReturn(state, records, action.endpointIds),
      };
    }
    case 'editUnchanged': {
      if (!state.editing) return state;
      const id = state.editing.endpointId;
      // Re-confirming a stale step without changes makes it complete again.
      let records =
        state.records[id]?.status === 'stale'
          ? withStatus(state.records, id, 'complete', { staleReason: undefined })
          : state.records;
      // The form showed the server's data; the record now matches it.
      if (action.values && records[id]) records = { ...records, [id]: { ...records[id], values: action.values } };
      return { ...state, records, editing: null, ...advanceKeepingReturn(state, records, action.endpointIds) };
    }
    case 'staleAccepted': {
      if (!state.editing) return state;
      const id = state.editing.endpointId;
      const records = withStatus(state.records, id, 'complete', { staleReason: undefined, followUp: action.followUp });
      return { ...state, records, editing: null, ...advanceKeepingReturn(state, records, action.endpointIds) };
    }
    case 'editCancelled': {
      if (!state.editing) return state;
      const base = { ...state, editing: null, errors: {}, executionError: null, pendingReturnIndex: null };
      const target = state.editing.returnIndex;
      const targetStatus = state.records[action.endpointIds[target]]?.status;
      if (targetStatus !== 'complete' && targetStatus !== 'stale') return { ...base, currentStepIndex: target };
      // A completed (or stale) step can't be shown outside edit mode: Continue
      // would create it again. Go where the user is needed instead.
      return { ...base, currentStepIndex: target, ...advance(base, state.records, action.endpointIds) };
    }
    case 'otherFailureCounted':
      return {
        ...state,
        otherFailures: { ...state.otherFailures, [action.endpointId]: (state.otherFailures[action.endpointId] ?? 0) + 1 },
      };
    case 'recoveryClassifying':
      return { ...state, recovery: { phase: 'classifying', endpointId: action.endpointId } };
    case 'classificationDropped':
      if (state.recovery.phase !== 'classifying' || state.recovery.endpointId !== action.endpointId) return state;
      return { ...state, recovery: IDLE_RECOVERY };
    case 'recoveryClassified':
      return {
        ...state,
        recovery: {
          phase: 'idle',
          endpointId: action.endpointId,
          classification: action.classification,
          explanation: action.explanation,
        },
      };
    case 'recoveryProposed':
      return {
        ...state,
        recovery: {
          phase: 'proposed',
          endpointId: action.endpointId,
          classification: 'fundamental',
          explanation: action.explanation,
          anchorId: action.anchorId,
          proposedUndo: action.undo,
          skipped: action.skipped,
          pending: action.undo.map((entry) => entry.endpointId),
          report: { undone: [], skipped: action.skipped },
        },
      };
    case 'recoveryDeclined':
      if (state.recovery.phase !== 'proposed') return state;
      return {
        ...state,
        recovery: {
          phase: 'idle',
          endpointId: state.recovery.endpointId,
          classification: state.recovery.classification,
          explanation: state.recovery.explanation,
        },
      };
    case 'rollbackStarted':
      return { ...state, recovery: { ...state.recovery, phase: 'rollingBack', report: { ...state.recovery.report!, failed: undefined } } };
    case 'undoSucceeded': {
      // An undone step is back to being filled in, without its resource id.
      const record = state.records[action.endpointId];
      const { resourceId: _gone, ...result } = record?.result ?? { success: true };
      const report = state.recovery.report ?? { undone: [], skipped: [] };
      return {
        ...state,
        records: withStatus(state.records, action.endpointId, 'idle', { result, staleReason: undefined }),
        recovery: {
          ...state.recovery,
          pending: (state.recovery.pending ?? []).filter((id) => id !== action.endpointId),
          report: { ...report, undone: [...report.undone, action.endpointId] },
        },
      };
    }
    case 'undoFailed': {
      const report = state.recovery.report ?? { undone: [], skipped: [] };
      return {
        ...state,
        recovery: {
          ...state.recovery,
          phase: 'rollbackFailed',
          report: {
            ...report,
            failed: { endpointId: action.endpointId, failure: action.result.failure, message: action.result.message },
          },
        },
      };
    }
    case 'rollbackFinished': {
      const failedId = state.recovery.endpointId!;
      let records = withStatus(state.records, failedId, 'idle');
      // A step in the undo range without a usable undo still owns a real
      // resource, but something it depends on is gone: it needs review (and
      // manual cleanup), so it can't stay 'complete'.
      for (const id of state.recovery.report?.skipped ?? []) {
        if (records[id]?.status === 'complete') {
          records = withStatus(records, id, 'stale', { staleReason: SKIPPED_BY_ROLLBACK_REASON });
        }
      }
      const base = { ...state, records, recovery: { ...state.recovery, phase: 'rolledBack' as const, pending: [] }, executionError: null };
      // Resume at the first step in flow order that needs the user -- normally
      // the anchor, now undone. Steps after it that were skipped are reviewed
      // once it is redone (through advance(), like any stale step). A stale
      // step has to be opened through goToStep, never re-created.
      const resumeId = action.endpointIds.find((id) => records[id]?.status !== 'complete')!;
      if (records[resumeId]?.status === 'stale') return { ...base, pendingRevisit: resumeId };
      return {
        ...base,
        currentStepIndex: action.endpointIds.indexOf(resumeId),
        prefill: { endpointId: resumeId, values: records[resumeId]?.values ?? {} },
      };
    }
  }
}

export function useAgentForm(flow: FlowDef, options: UseAgentFormOptions): UseAgentFormResult {
  const sessionIdRef = useRef<string | undefined>(undefined);
  if (!sessionIdRef.current) {
    sessionIdRef.current = randomId();
  }

  const [state, dispatch] = useReducer(reducer, initialState);
  // Callbacks read the latest state through this ref, so they don't need to be
  // recreated (and re-subscribed by the host) on every keystroke.
  const stateRef = useRef(state);
  stateRef.current = state;
  // Read at call time, so a host that changes the flow's guidance is heard
  // without re-creating every callback.
  const wireFlowRef = useRef(toWireFlow(flow));
  wireFlowRef.current = toWireFlow(flow);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const warnedMissingIdRef = useRef(new Set<string>());
  // Read at call time, so a host that passes a new callback each render isn't a problem.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const emitRecoveryEvent = useCallback((event: RecoveryEvent) => optionsRef.current.onRecoveryEvent?.(event), []);
  // confirmRollback must be idempotent even for two clicks in the same tick,
  // which state alone (updated on the next render) can't guarantee.
  const rollingBackRef = useRef(false);
  const undoKeysRef = useRef<Record<string, string>>({});
  // The classification in flight, if its verdict still applies. Kept in a ref
  // rather than read from stateRef: a fast answer can arrive before React has
  // rendered the state that started it.
  const classificationRunRef = useRef(0);
  const pendingClassificationRef = useRef<{ endpointId: string; run: number; controller: AbortController } | null>(null);
  // Nobody is left to act on a verdict: cancel the request. recoverFrom sees
  // the abort and returns without a fallback verdict, events or a warning.
  useEffect(
    () => () => {
      pendingClassificationRef.current?.controller.abort();
      pendingClassificationRef.current = null;
    },
    []
  );

  const currentEndpoint = flow.endpoints[state.currentStepIndex];
  const endpointIds = useMemo(() => flow.endpoints.map((endpoint) => endpoint.id), [flow.endpoints]);
  const precedingIds = useCallback((index: number) => endpointIds.slice(0, index), [endpointIds]);

  // ctx.results: every step that still owns a resource. A stale step counts --
  // an earlier edit flagged it, but what it created still exists, and a nested
  // step's operations need its id. Undone steps are idle with no result.
  const completedResults = useCallback(() => {
    const results: Record<string, OperationResult> = {};
    for (const record of Object.values(stateRef.current.records)) {
      if ((record.status === 'complete' || record.status === 'stale') && record.result) results[record.endpointId] = record.result;
    }
    return results;
  }, []);

  // On entering a step, fetch its AI-adapted fields, scoped to the steps
  // before it -- which also re-adapts a revisited step
  // to the earlier answers as they are now. If the request itself fails (not
  // the server's own graceful degradation, which already comes back as a
  // normal 200 -- see stepEngine.ts), fall back client-side to the endpoint's
  // full base field list. Aborts on step change/unmount.
  useEffect(() => {
    if (!currentEndpoint) {
      dispatch({ type: 'fatal', error: new Error('useAgentForm: flow has no endpoints.') });
      return;
    }

    const controller = new AbortController();
    dispatch({ type: 'stepEntered', endpointId: currentEndpoint.id, fields: currentEndpoint.fields });

    postJson<StepFieldsResponse>(
      `${options.apiUrl}/api/step/fields`,
      {
        sessionId: sessionIdRef.current,
        flow: wireFlowRef.current,
        endpoint: toWireEndpoint(currentEndpoint),
        precedingEndpointIds: precedingIds(state.currentStepIndex),
      },
      controller.signal
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        dispatch({ type: 'fieldsLoaded', fields: result.fields, suggestedValues: result.suggestedValues });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        console.warn(
          `useAgentForm: /api/step/fields failed for "${currentEndpoint.id}", falling back to the full base field list.`,
          err
        );
        dispatch({ type: 'fieldsFellBack', fields: currentEndpoint.fields });
      });

    return () => controller.abort();
    // Keyed on ids, not on the flow object: a host that rebuilds an equal flow
    // on every render (e.g. to attach operations) must not wipe what the user
    // has typed or trigger another LLM call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.currentStepIndex, flow.id, currentEndpoint?.id, options.apiUrl]);

  const validateOnServer = useCallback(
    async (endpoint: EndpointDef, index: number, data: Record<string, unknown>): Promise<StepValidateResponse> => {
      try {
        return await postJson<StepValidateResponse>(`${options.apiUrl}/api/step/validate`, {
          sessionId: sessionIdRef.current,
          flow: wireFlowRef.current,
          endpoint: toWireEndpoint(endpoint),
          data,
          precedingEndpointIds: precedingIds(index),
        });
      } catch (err) {
        // Client-side mirror of the server's graceful degradation: the semantic
        // check itself couldn't be reached, so fall back to accepting the
        // client-side validation as sufficient rather than blocking.
        console.warn(
          `useAgentForm: /api/step/validate failed for "${endpoint.id}", accepting client-side validation only.`,
          err
        );
        return { valid: true, errors: {}, degraded: true };
      }
    },
    [options.apiUrl, precedingIds]
  );

  // Brings the server session back to what was actually submitted. Best
  // effort: the session only feeds later prompts.
  const syncSession = useCallback(
    (endpointId: string, data: Record<string, unknown> | null) => {
      postJson(`${options.apiUrl}/api/session/sync`, {
        sessionId: sessionIdRef.current,
        steps: [{ endpointId, data }],
      }).catch((err: unknown) => console.warn(`useAgentForm: /api/session/sync failed for "${endpointId}".`, err));
    },
    [options.apiUrl]
  );

  // Decide what the user can do about a failed create (README: "When a step fails").
  const recoverFrom = useCallback(
    async (endpoint: EndpointDef, result: OperationResult) => {
      const { otherFailures, records } = stateRef.current;
      const failure = result.failure;
      if (!failure || failure.kind === 'other') dispatch({ type: 'otherFailureCounted', endpointId: endpoint.id });

      const pre = preClassify(failure, otherFailures[endpoint.id] ?? 0);
      if (pre.verdict === 'retryable') {
        dispatch({ type: 'recoveryClassified', endpointId: endpoint.id, classification: 'retryable', explanation: pre.explanation });
        emitRecoveryEvent({ type: 'classified', endpointId: endpoint.id, classification: 'retryable', byModel: false });
        return;
      }

      const run = ++classificationRunRef.current;
      const controller = new AbortController();
      pendingClassificationRef.current = { endpointId: endpoint.id, run, controller };
      dispatch({ type: 'recoveryClassifying', endpointId: endpoint.id });
      // Steps that own a real resource: complete ones, and stale ones (an
      // earlier edit flagged them, but what they created still exists).
      const completed = flow.endpoints.filter((e) => {
        const record = records[e.id];
        return (record?.status === 'complete' || record?.status === 'stale') && record.result !== undefined;
      });
      let verdict: { classification: FailureClassification; explanation: string; rollbackFromEndpointId: string | null };
      try {
        verdict = await postJson(
          `${options.apiUrl}/api/step/classify-failure`,
          {
            sessionId: sessionIdRef.current,
            flow: wireFlowRef.current,
            failedEndpoint: toWireEndpoint(endpoint),
            failure: failure ?? { kind: 'other', message: result.message },
            completedEndpoints: completed.map(toWireEndpoint),
          },
          controller.signal
        );
      } catch (err) {
        // Aborted because the user changed the step: already dropped and
        // unlocked by updateField, so no fallback verdict and no events.
        if (controller.signal.aborted) return;
        // Safe side: no classification means no undo proposal.
        console.warn(`useAgentForm: /api/step/classify-failure failed for "${endpoint.id}".`, err);
        verdict = {
          classification: 'retryable',
          explanation: 'The cause could not be determined. You can try again, change your answers, or stop here.',
          rollbackFromEndpointId: null,
        };
      }
      if (!isMountedRef.current) return;
      // The verdict is about the failure as it was. If the user has since
      // changed the step (typing reopens it), drop it and make sure the lock
      // is released (updateField normally did that already).
      if (pendingClassificationRef.current?.run !== run) {
        dispatch({ type: 'classificationDropped', endpointId: endpoint.id });
        return;
      }
      pendingClassificationRef.current = null;
      emitRecoveryEvent({ type: 'classified', endpointId: endpoint.id, classification: verdict.classification, byModel: true });

      const anchor = verdict.rollbackFromEndpointId;
      const anchorIndex = anchor ? endpointIds.indexOf(anchor) : -1;
      const rollbackAllowed = (optionsRef.current.recovery?.rollback ?? 'confirm') === 'confirm';
      if (verdict.classification === 'fundamental' && anchor && rollbackAllowed && completed.some((e) => e.id === anchor)) {
        // From the anchor through the last completed step, undone in reverse.
        const range = completed.filter((e) => endpointIds.indexOf(e.id) >= anchorIndex).reverse();
        const undoable = range.filter((e) => operationsOf(e).undo && records[e.id]?.result?.resourceId);
        const skipped = range.filter((e) => !undoable.includes(e)).map((e) => e.id);
        if (undoable.length > 0) {
          const undo = undoable.map((e) => ({ endpointId: e.id, label: e.title }));
          dispatch({ type: 'recoveryProposed', endpointId: endpoint.id, explanation: verdict.explanation, anchorId: anchor, undo, skipped });
          emitRecoveryEvent({ type: 'proposed', endpointId: endpoint.id, undo: undo.map((u) => u.endpointId), skipped });
          return;
        }
        const titles = range.map((e) => e.title).join(', ');
        dispatch({
          type: 'recoveryClassified',
          endpointId: endpoint.id,
          classification: 'fundamental',
          explanation: `${verdict.explanation} Nothing here can be undone automatically (${titles}); it needs manual cleanup.`,
        });
        return;
      }

      dispatch({
        type: 'recoveryClassified',
        endpointId: endpoint.id,
        classification: verdict.classification,
        explanation: verdict.explanation,
      });
    },
    [flow.endpoints, endpointIds, options.apiUrl, emitRecoveryEvent]
  );

  // Runs the remaining undos in order and stops at the first failure.
  const runUndos = useCallback(
    async (ids: string[]) => {
      for (const id of ids) {
        const endpoint = flow.endpoints[endpointIds.indexOf(id)];
        const resourceId = stateRef.current.records[id]?.result?.resourceId;
        const undo = operationsOf(endpoint).undo;
        undoKeysRef.current[id] ??= randomId();

        let result: OperationResult;
        try {
          result = normalizeResult(
            await undo!({
              getAuthHeaders: optionsRef.current.getAuthHeaders,
              results: completedResults(),
              idempotencyKey: undoKeysRef.current[id],
              resourceId: resourceId!,
            })
          );
        } catch (err) {
          result = resultFromError(err);
        }
        // An undo already in flight is allowed to finish; nothing after it runs.
        if (!isMountedRef.current) return;

        if (!result.success) {
          dispatch({ type: 'undoFailed', endpointId: id, result });
          emitRecoveryEvent({ type: 'undoFailed', endpointId: id, failure: result.failure });
          return;
        }
        delete undoKeysRef.current[id];
        dispatch({ type: 'undoSucceeded', endpointId: id });
        syncSession(id, null);
        emitRecoveryEvent({ type: 'undone', endpointId: id });
      }
      const failedId = stateRef.current.recovery.endpointId;
      if (failedId) syncSession(failedId, null);
      dispatch({ type: 'rollbackFinished', endpointIds });
    },
    [flow.endpoints, endpointIds, completedResults, syncSession, emitRecoveryEvent]
  );

  const confirmRollback = useCallback(async () => {
    const { recovery } = stateRef.current;
    if (recovery.phase !== 'proposed' || rollingBackRef.current) return;
    rollingBackRef.current = true;
    dispatch({ type: 'rollbackStarted' });
    emitRecoveryEvent({ type: 'confirmed', endpointId: recovery.endpointId! });
    try {
      await runUndos(recovery.pending ?? []);
    } finally {
      rollingBackRef.current = false;
    }
  }, [runUndos, emitRecoveryEvent]);

  const retryRollback = useCallback(async () => {
    const { recovery } = stateRef.current;
    if (recovery.phase !== 'rollbackFailed' || rollingBackRef.current) return;
    rollingBackRef.current = true;
    dispatch({ type: 'rollbackStarted' });
    try {
      await runUndos(recovery.pending ?? []);
    } finally {
      rollingBackRef.current = false;
    }
  }, [runUndos]);

  const declineRollback = useCallback(() => {
    const { recovery } = stateRef.current;
    if (recovery.phase !== 'proposed') return;
    dispatch({ type: 'recoveryDeclined' });
    emitRecoveryEvent({ type: 'declined', endpointId: recovery.endpointId! });
  }, [emitRecoveryEvent]);

  const runCreate = useCallback(
    async (endpoint: EndpointDef, data: Record<string, unknown>) => {
      const idempotencyKey = stateRef.current.idempotencyKeys[endpoint.id] ?? randomId();
      dispatch({ type: 'executing', endpointId: endpoint.id, idempotencyKey });
      const context: ExecContext = { getAuthHeaders: options.getAuthHeaders, results: completedResults(), idempotencyKey };

      let result: OperationResult;
      try {
        result = normalizeResult(await operationsOf(endpoint).create(data, context));
      } catch (err) {
        result = resultFromError(err);
      }
      if (!isMountedRef.current) return;

      if (result.success) {
        const declared = implementedCapabilities(endpoint);
        const declaresItemOps = declared.read || declared.update || declared.undo;
        if (declaresItemOps && !result.resourceId && !warnedMissingIdRef.current.has(endpoint.id)) {
          warnedMissingIdRef.current.add(endpoint.id);
          console.warn(
            `useAgentForm: "${endpoint.id}" implements read/update/undo, but create() returned no resourceId, so those operations can't be used for this step.`
          );
        }
        dispatch({
          type: 'createSucceeded',
          endpointId: endpoint.id,
          values: data,
          fieldNames: stateRef.current.currentStepFields.map((field) => field.name),
          result,
          endpointIds,
        });
      } else {
        dispatch({ type: 'createFailed', endpointId: endpoint.id, values: data, result });
        await recoverFrom(endpoint, result);
      }
    },
    [endpointIds, options.getAuthHeaders, completedResults, recoverFrom]
  );

  // LLM #5 (cross-step invalidation): which later completed steps does this change
  // plausibly affect? Unreachable server → every one of them (safe side).
  const checkLaterSteps = useCallback(
    async (endpoint: EndpointDef, before: Record<string, unknown>, after: Record<string, unknown>) => {
      const later = laterCompletedIds(stateRef.current.records, endpointIds, endpoint.id);
      if (later.length === 0) return [];

      dispatch({ type: 'editPhase', phase: 'checking' });
      try {
        const response = await postJson<{ affected: { endpointId: string; reason: string }[] }>(
          `${options.apiUrl}/api/step/check-invalidation`,
          {
            sessionId: sessionIdRef.current,
            flow: wireFlowRef.current,
            editedEndpoint: toWireEndpoint(endpoint),
            before,
            after,
            laterCompletedEndpoints: later.map((id) => toWireEndpoint(flow.endpoints[endpointIds.indexOf(id)])),
          }
        );
        // Only trust ids this hook asked about.
        return response.affected.filter((entry) => later.includes(entry.endpointId));
      } catch (err) {
        console.warn(`useAgentForm: /api/step/check-invalidation failed for "${endpoint.id}"; flagging every later step.`, err);
        return later.map((endpointId) => ({ endpointId, reason: SAFE_SIDE_STALE_REASON }));
      }
    },
    [endpointIds, flow.endpoints, options.apiUrl]
  );

  const submitEdit = useCallback(
    async (endpoint: EndpointDef, editing: Editing) => {
      if (editing.phase !== 'idle' || recoveryLocked(stateRef.current)) return;
      const { currentStepFields, values, records, idempotencyKeys } = stateRef.current;
      const record = records[endpoint.id];

      // A step that can't be changed here is resolved through acknowledgeStale
      // or flagForFollowUp instead.
      if (editing.mode === 'readOnly') return;
      const previousValues = editing.baseline;

      if (isUnchanged(currentStepFields, values, previousValues, record?.fieldNames)) {
        // Read may have shown data newer than the local record: adopt it, with
        // no update and no invalidation check, since the user changed nothing.
        const adopt = !sameValues(previousValues, record?.values ?? {});
        if (adopt) syncSession(endpoint.id, previousValues);
        dispatch({ type: 'editUnchanged', endpointIds, ...(adopt ? { values: previousValues } : {}) });
        return;
      }

      const data = visibleValues(currentStepFields, values);
      const clientErrors = validateClientSide(currentStepFields, data);
      if (Object.keys(clientErrors).length > 0) {
        dispatch({ type: 'editInvalid', errors: clientErrors });
        return;
      }

      dispatch({ type: 'editPhase', phase: 'validating' });
      const verdict = await validateOnServer(endpoint, state.currentStepIndex, data);
      if (!isMountedRef.current) return;
      if (!verdict.valid) {
        syncSession(endpoint.id, previousValues);
        dispatch({ type: 'editInvalid', errors: verdict.errors });
        return;
      }

      const idempotencyKey = idempotencyKeys[endpoint.id] ?? randomId();
      dispatch({ type: 'editPhase', phase: 'saving', idempotencyKey });
      const update = operationsOf(endpoint).update!;
      let result: OperationResult;
      try {
        result = normalizeResult(
          await update(data, {
            getAuthHeaders: options.getAuthHeaders,
            results: completedResults(),
            idempotencyKey,
            previousValues,
            resourceId: record!.result!.resourceId!,
          })
        );
      } catch (err) {
        result = resultFromError(err);
      }
      if (!isMountedRef.current) return;

      if (result.success) {
        const stale = await checkLaterSteps(endpoint, previousValues, data);
        if (!isMountedRef.current) return;
        dispatch({
          type: 'editSaved',
          values: data,
          fieldNames: currentStepFields.map((field) => field.name),
          result,
          stale,
          endpointIds,
        });
      } else {
        // /api/step/validate already recorded the edited values.
        syncSession(endpoint.id, previousValues);
        dispatch({ type: 'editFailed', message: result.message ?? 'The update failed.' });
      }
    },
    [endpointIds, options.getAuthHeaders, completedResults, validateOnServer, syncSession, state.currentStepIndex, checkLaterSteps]
  );

  const submitStep = useCallback(async () => {
    if (!currentEndpoint) return;
    // Between saving an edit and opening the next step to review, the step on
    // screen must not be submitted again (that would re-run create).
    if (stateRef.current.navigating || stateRef.current.pendingRevisit) return;
    if (recoveryLocked(stateRef.current)) return;
    const { editing } = stateRef.current;
    if (editing) {
      await submitEdit(currentEndpoint, editing);
      return;
    }
    // Outside edit mode only a step without a resource may be submitted: a
    // complete or stale one would be created a second time.
    const status = stateRef.current.records[currentEndpoint.id]?.status;
    if (status === 'complete' || status === 'stale') return;

    const { currentStepFields, values } = stateRef.current;
    const clientErrors = validateClientSide(currentStepFields, values);
    if (Object.keys(clientErrors).length > 0) {
      dispatch({ type: 'clientInvalid', endpointId: currentEndpoint.id, errors: clientErrors });
      return;
    }

    dispatch({ type: 'validating', endpointId: currentEndpoint.id });
    const verdict = await validateOnServer(currentEndpoint, state.currentStepIndex, values);
    if (!isMountedRef.current) return;

    if (!verdict.valid) {
      dispatch({ type: 'serverInvalid', endpointId: currentEndpoint.id, errors: verdict.errors });
      return;
    }

    await runCreate(currentEndpoint, values);
  }, [currentEndpoint, state.currentStepIndex, validateOnServer, runCreate, submitEdit]);

  // Re-runs create with the same, already-validated data and the same
  // idempotency key -- no new semantic check.
  const retryExecution = useCallback(async () => {
    if (!currentEndpoint) return;
    if (stateRef.current.navigating || stateRef.current.pendingRevisit) return;
    if (recoveryLocked(stateRef.current)) return;
    if (stateRef.current.records[currentEndpoint.id]?.status !== 'executionFailed') return;
    await runCreate(currentEndpoint, stateRef.current.values);
  }, [currentEndpoint, runCreate]);

  const updateField = useCallback(
    (fieldName: string, value: unknown) => {
      if (!currentEndpoint) return;
      if (stateRef.current.editing?.mode === 'readOnly') return;
      // Typing reopens a failed step, so a verdict still on its way no longer
      // applies: cancel the request and unlock now. A verdict that already
      // arrived is dropped by the run check in recoverFrom.
      const pending = pendingClassificationRef.current;
      if (!stateRef.current.editing && pending?.endpointId === currentEndpoint.id) {
        pendingClassificationRef.current = null;
        pending.controller.abort();
        dispatch({ type: 'classificationDropped', endpointId: currentEndpoint.id });
      }
      dispatch({ type: 'fieldUpdated', endpointId: currentEndpoint.id, name: fieldName, value });
    },
    [currentEndpoint]
  );

  const canGoToStep = useCallback(
    (endpointId: string) => {
      const { records, currentStepIndex, editing } = stateRef.current;
      const index = endpointIds.indexOf(endpointId);
      if (index === -1 || recoveryLocked(stateRef.current)) return false;
      // Once every step is done, the last one is no longer "where the user is".
      const allComplete = endpointIds.every((id) => records[id]?.status === 'complete');
      if (index === currentStepIndex && !(allComplete && !editing)) return false;
      if (editing && editing.phase !== 'idle') return false;
      const status = records[endpointId]?.status;
      if (status !== 'complete' && status !== 'stale') return false;
      // Never forward past the first step that still needs the user.
      const firstOpen = endpointIds.findIndex((id) => records[id]?.status !== 'complete');
      return firstOpen === -1 || index <= firstOpen;
    },
    [endpointIds]
  );

  const goToStep = useCallback(
    async (endpointId: string) => {
      if (recoveryLocked(stateRef.current) || !canGoToStep(endpointId)) return;
      const { records, currentStepIndex, values, editing } = stateRef.current;
      const index = endpointIds.indexOf(endpointId);
      const endpoint = flow.endpoints[index];
      const record = records[endpointId];
      const ops = operationsOf(endpoint);
      const resourceId = record.result?.resourceId;

      // Keep what was typed on an unfinished step, to restore on return.
      const leavingId = endpointIds[currentStepIndex];
      const draft =
        !editing && leavingId && records[leavingId]?.status !== 'complete' && Object.keys(values).length > 0
          ? { endpointId: leavingId, values }
          : null;

      dispatch({ type: 'navigationStarted' });
      let prefill = record.values;
      if (ops.read && resourceId) {
        try {
          const found = await ops.read({
            getAuthHeaders: options.getAuthHeaders,
            results: completedResults(),
            idempotencyKey: randomId(),
            resourceId,
          });
          if (!isMountedRef.current) return;
          if (!found.found) {
            dispatch({ type: 'resourceMissing', endpointId, targetIndex: index, endpointIds, draft });
            return;
          }
          // The server's current state wins over the local record, for the
          // fields it actually returns (see readOverLocal).
          prefill = readOverLocal(endpoint, record.values ?? {}, found.data);
        } catch (err) {
          if (!isMountedRef.current) return;
          const message = err instanceof Error ? err.message : String(err);
          dispatch({ type: 'navigationFailed', message: `Couldn't load "${endpoint.title}": ${message}` });
          return;
        }
      }

      dispatch({
        type: 'editStarted',
        endpointId,
        targetIndex: index,
        mode: ops.update && resourceId ? 'editable' : 'readOnly',
        prefill,
        draft,
      });
    },
    [canGoToStep, endpointIds, flow.endpoints, options.getAuthHeaders, completedResults]
  );

  // A stale step reached by the "where next" rule is opened through goToStep,
  // like a click on it would.
  useEffect(() => {
    if (state.pendingRevisit) void goToStep(state.pendingRevisit);
  }, [state.pendingRevisit, goToStep]);

  const cancelEdit = useCallback(() => {
    const { editing, records } = stateRef.current;
    if (!editing || editing.phase !== 'idle') return;
    syncSession(editing.endpointId, records[editing.endpointId]?.values ?? null);
    dispatch({ type: 'editCancelled', endpointIds });
  }, [syncSession, endpointIds]);

  const editingStale =
    state.editing !== null &&
    !state.loading &&
    state.editing.phase === 'idle' &&
    state.records[state.editing.endpointId]?.status === 'stale';
  const fieldsKept = editingStale
    ? sameFieldSet(state.currentStepFields, state.records[state.editing!.endpointId]?.fieldNames)
    : false;
  const staleResolution: StaleResolution | null = !editingStale
    ? null
    : fieldsKept
      ? 'keepOrEdit'
      : state.editing!.mode === 'editable'
        ? 'mustEdit'
        : 'followUp';

  const acknowledgeStale = useCallback((): { ok: true } | { ok: false; reason: 'fieldsChanged' | 'notStale' } => {
    if (staleResolution === null) return { ok: false, reason: 'notStale' };
    if (staleResolution !== 'keepOrEdit') return { ok: false, reason: 'fieldsChanged' };
    dispatch({ type: 'staleAccepted', endpointIds });
    return { ok: true };
  }, [staleResolution, endpointIds]);

  const flagForFollowUp = useCallback(() => {
    if (staleResolution !== 'followUp') return;
    const record = stateRef.current.records[stateRef.current.editing!.endpointId];
    dispatch({
      type: 'staleAccepted',
      followUp: `${record?.staleReason ?? SAFE_SIDE_STALE_REASON} Its fields changed, and it can't be changed in this wizard.`,
      endpointIds,
    });
  }, [staleResolution, endpointIds]);

  const followUps = useMemo(
    () =>
      flow.endpoints
        .filter((endpoint) => state.records[endpoint.id]?.followUp)
        .map((endpoint) => ({ endpointId: endpoint.id, note: state.records[endpoint.id]!.followUp! })),
    [flow.endpoints, state.records]
  );

  const completedEndpoints = useMemo(
    () => flow.endpoints.filter((endpoint) => state.records[endpoint.id]?.status === 'complete').map((endpoint) => endpoint.id),
    [flow.endpoints, state.records]
  );

  const isComplete = flow.endpoints.length > 0 && completedEndpoints.length === flow.endpoints.length;
  const currentStepStatus: StepStatus = currentEndpoint ? state.records[currentEndpoint.id]?.status ?? 'idle' : 'idle';

  return {
    currentStepIndex: state.currentStepIndex,
    totalSteps: flow.endpoints.length,
    currentStepFields: state.currentStepFields,
    suggestedValues: state.suggestedValues,
    values: state.values,
    errors: state.errors,
    currentStepStatus,
    executionError: state.executionError,
    loading: state.loading,
    updateField,
    submitStep,
    retryExecution,
    completedEndpoints,
    isComplete,
    stepRecords: state.records,
    canGoToStep,
    goToStep,
    cancelEdit,
    acknowledgeStale,
    flagForFollowUp,
    staleResolution,
    followUps,
    recovery: {
      phase: state.recovery.phase,
      endpointId: state.recovery.endpointId,
      classification: state.recovery.classification,
      explanation: state.recovery.explanation,
      proposedUndo: state.recovery.proposedUndo,
      skipped: state.recovery.skipped,
      report: state.recovery.report,
    },
    confirmRollback,
    declineRollback,
    retryRollback,
    isEditing: state.editing !== null,
    editMode: state.editing?.mode ?? null,
    editPhase: state.editing?.phase ?? 'idle',
    navigationError: state.navigationError,
    navigating: state.navigating || state.pendingRevisit !== null,
    error: state.error,
  };
}
