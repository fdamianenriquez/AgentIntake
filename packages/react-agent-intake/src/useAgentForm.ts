import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { EndpointDef, ExecContext, FieldDef, FlowDef, OperationResult } from './contracts.js';
import { implementedCapabilities, normalizeResult, operationsOf, resultFromError } from './operations.js';

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
}

/**
 * When revisiting a completed step: `editable` when the author implemented
 * `update` and create returned a `resourceId`, otherwise `readOnly` (the step
 * can be looked at but not changed). See README: "Revisiting completed steps".
 */
export type EditMode = 'editable' | 'readOnly';
export type EditPhase = 'idle' | 'validating' | 'saving';

export interface UseAgentFormOptions {
  apiUrl: string;
  // The direct-from-browser auth pattern (README: "Authentication model"):
  // flows into each operation's context. May be async (e.g. refreshing a token).
  getAuthHeaders?: () => Promise<Record<string, string>> | Record<string, string>;
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
  isEditing: boolean;
  editMode: EditMode | null;
  editPhase: EditPhase;
  /** Set when revisiting a step failed (e.g. its `read` threw); the user stays where they were. */
  navigationError: string | null;
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

// "Unchanged" means: every visible field has the same value as last time, and
// nothing that was filled in last time is now hidden (the field set moved).
function isUnchanged(fields: FieldDef[], values: Record<string, unknown>, previous: Record<string, unknown>): boolean {
  const visible = new Set(fields.map((field) => field.name));
  for (const field of fields) {
    const now = values[field.name];
    const before = previous[field.name];
    if (!(isEmptyValue(now) && isEmptyValue(before)) && now !== before) return false;
  }
  return Object.entries(previous).every(([name, value]) => visible.has(name) || isEmptyValue(value));
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
  | { type: 'createSucceeded'; endpointId: string; values: Record<string, unknown>; result: OperationResult; endpointIds: string[] }
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
  | { type: 'editSaved'; values: Record<string, unknown>; result: OperationResult; endpointIds: string[] }
  | { type: 'editUnchanged'; endpointIds: string[] }
  | { type: 'editCancelled' };

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

// Once a step's data changes,
// every later completed step may no longer fit and has to be looked at again.
// narrows this down with an LLM check.
function markLaterStale(records: Record<string, StepRecord>, endpointIds: string[], editedId: string) {
  let next = records;
  for (const id of endpointIds.slice(endpointIds.indexOf(editedId) + 1)) {
    if (next[id]?.status === 'complete') next = withStatus(next, id, 'stale');
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
        result: action.result,
      });
      return {
        ...state,
        records,
        idempotencyKeys: withoutKey(state.idempotencyKeys, action.endpointId),
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
      return { ...state, navigationError: null, pendingRevisit: null };
    case 'navigationFailed':
      return { ...state, navigationError: action.message };
    case 'editStarted':
      return {
        ...state,
        editing: {
          endpointId: action.endpointId,
          returnIndex: state.editing?.returnIndex ?? state.currentStepIndex,
          mode: action.mode,
          phase: 'idle',
        },
        prefill: { endpointId: action.endpointId, values: action.prefill },
        drafts: withDraft(state.drafts, action.draft),
        currentStepIndex: action.targetIndex,
      };
    case 'resourceMissing': {
      // The resource is gone (read found nothing), so this step has to be created
      // again (from the local record) and everything after it re-checked.
      const record = state.records[action.endpointId];
      const { resourceId: _gone, ...result } = record?.result ?? { success: true };
      let records = withStatus(state.records, action.endpointId, 'idle', { result });
      records = markLaterStale(records, action.endpointIds, action.endpointId);
      return {
        ...state,
        records,
        editing: null,
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
        result: { ...action.result, resourceId: action.result.resourceId ?? previousId },
      });
      records = markLaterStale(records, action.endpointIds, id);
      return {
        ...state,
        records,
        editing: null,
        idempotencyKeys: withoutKey(state.idempotencyKeys, id),
        ...advance(state, records, action.endpointIds),
      };
    }
    case 'editUnchanged': {
      if (!state.editing) return state;
      const id = state.editing.endpointId;
      // Re-confirming a stale step without changes makes it complete again.
      const records = state.records[id]?.status === 'stale' ? withStatus(state.records, id, 'complete') : state.records;
      return { ...state, records, editing: null, ...advance(state, records, action.endpointIds) };
    }
    case 'editCancelled':
      if (!state.editing) return state;
      return { ...state, editing: null, errors: {}, executionError: null, currentStepIndex: state.editing.returnIndex };
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

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const warnedMissingIdRef = useRef(new Set<string>());

  const currentEndpoint = flow.endpoints[state.currentStepIndex];
  const endpointIds = useMemo(() => flow.endpoints.map((endpoint) => endpoint.id), [flow.endpoints]);
  const precedingIds = useCallback((index: number) => endpointIds.slice(0, index), [endpointIds]);

  const completedResults = useCallback(() => {
    const results: Record<string, OperationResult> = {};
    for (const record of Object.values(stateRef.current.records)) {
      if (record.status === 'complete' && record.result) results[record.endpointId] = record.result;
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
        dispatch({ type: 'createSucceeded', endpointId: endpoint.id, values: data, result, endpointIds });
      } else {
        dispatch({ type: 'createFailed', endpointId: endpoint.id, values: data, result });
      }
    },
    [endpointIds, options.getAuthHeaders, completedResults]
  );

  const submitEdit = useCallback(
    async (endpoint: EndpointDef, editing: Editing) => {
      if (editing.phase !== 'idle') return;
      const { currentStepFields, values, records, idempotencyKeys } = stateRef.current;
      const record = records[endpoint.id];

      // A step that can't be changed here can still be confirmed as-is once an
      // earlier answer changed; otherwise the flow could never complete.
      if (editing.mode === 'readOnly') {
        if (record?.status === 'stale') dispatch({ type: 'editUnchanged', endpointIds });
        return;
      }
      const previousValues = record?.values ?? {};

      if (isUnchanged(currentStepFields, values, previousValues)) {
        dispatch({ type: 'editUnchanged', endpointIds });
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
        dispatch({ type: 'editSaved', values: data, result, endpointIds });
      } else {
        // /api/step/validate already recorded the edited values.
        syncSession(endpoint.id, previousValues);
        dispatch({ type: 'editFailed', message: result.message ?? 'The update failed.' });
      }
    },
    [endpointIds, options.getAuthHeaders, completedResults, validateOnServer, syncSession, state.currentStepIndex]
  );

  const submitStep = useCallback(async () => {
    if (!currentEndpoint) return;
    const { editing } = stateRef.current;
    if (editing) {
      await submitEdit(currentEndpoint, editing);
      return;
    }

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
    if (stateRef.current.records[currentEndpoint.id]?.status !== 'executionFailed') return;
    await runCreate(currentEndpoint, stateRef.current.values);
  }, [currentEndpoint, runCreate]);

  const updateField = useCallback(
    (fieldName: string, value: unknown) => {
      if (!currentEndpoint) return;
      if (stateRef.current.editing?.mode === 'readOnly') return;
      dispatch({ type: 'fieldUpdated', endpointId: currentEndpoint.id, name: fieldName, value });
    },
    [currentEndpoint]
  );

  const canGoToStep = useCallback(
    (endpointId: string) => {
      const { records, currentStepIndex, editing } = stateRef.current;
      const index = endpointIds.indexOf(endpointId);
      if (index === -1) return false;
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
      if (!canGoToStep(endpointId)) return;
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
          prefill = found.data; // the server's current state wins over the local record
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
    dispatch({ type: 'editCancelled' });
  }, [syncSession]);

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
    isEditing: state.editing !== null,
    editMode: state.editing?.mode ?? null,
    editPhase: state.editing?.phase ?? 'idle',
    navigationError: state.navigationError,
    error: state.error,
  };
}
