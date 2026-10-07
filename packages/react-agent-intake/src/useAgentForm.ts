import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { EndpointDef, ExecContext, FieldDef, FlowDef, OperationResult } from './contracts.js';
import { implementedCapabilities, normalizeResult, operationsOf, resultFromError } from './operations.js';

// StepStatus (README: "The `StepStatus` lifecycle") is the single source of truth for a step's
// lifecycle -- never inferred from separate booleans. 'complete' is
// reserved exclusively for a successful create; a step that only passed
// semantic validation is 'executing' or 'executionFailed', never 'complete'.
export type StepStatus = 'idle' | 'validating' | 'invalid' | 'executing' | 'complete' | 'executionFailed';

/** What the hook remembers about each step, kept after the user moves on. */
export interface StepRecord {
  endpointId: string;
  /** The last values submitted for this step. */
  values: Record<string, unknown>;
  /** The last create result, including `resourceId` when the author returned one. */
  result?: OperationResult;
  status: StepStatus;
}

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

// Fast, local checks per FieldDef, before any network call -- not a
// replacement for server-side semantic validation, just enough to
// avoid a round-trip for obviously-missing/malformed input.
function validateClientSide(fields: FieldDef[], values: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {};

  for (const field of fields) {
    const value = values[field.name];
    const isEmpty = value === undefined || value === null || value === '';

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

async function fetchStepFields(
  apiUrl: string,
  sessionId: string,
  endpoint: EndpointDef,
  signal: AbortSignal
): Promise<StepFieldsResponse> {
  const response = await fetch(`${apiUrl}/api/step/fields`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, endpoint: toWireEndpoint(endpoint) }),
    signal,
  });
  if (!response.ok) throw new Error(`/api/step/fields responded with ${response.status}`);
  return response.json();
}

async function postStepValidate(
  apiUrl: string,
  sessionId: string,
  endpoint: EndpointDef,
  data: Record<string, unknown>
): Promise<StepValidateResponse> {
  const response = await fetch(`${apiUrl}/api/step/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, endpoint: toWireEndpoint(endpoint), data }),
  });
  if (!response.ok) throw new Error(`/api/step/validate responded with ${response.status}`);
  return response.json();
}

// ---------------------------------------------------------------------------
// State: one reducer, so combinations the StepStatus machine forbids can't be
// represented by separately-updated pieces of state.
// ---------------------------------------------------------------------------

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
  /** Per endpoint: the key for the create currently being attempted. */
  idempotencyKeys: Record<string, string>;
}

type FormAction =
  | { type: 'fatal'; error: Error }
  | { type: 'stepEntered'; fields: FieldDef[] }
  | { type: 'fieldsLoaded'; fields: FieldDef[]; suggestedValues: Record<string, unknown> }
  | { type: 'fieldsFellBack'; fields: FieldDef[] }
  | { type: 'fieldUpdated'; endpointId: string; name: string; value: unknown }
  | { type: 'clientInvalid'; endpointId: string; errors: Record<string, string> }
  | { type: 'validating'; endpointId: string }
  | { type: 'serverInvalid'; endpointId: string; errors: Record<string, string> }
  | { type: 'executing'; endpointId: string; idempotencyKey: string }
  | { type: 'createSucceeded'; endpointId: string; values: Record<string, unknown>; result: OperationResult; endpointIds: string[] }
  | { type: 'createFailed'; endpointId: string; values: Record<string, unknown>; result: OperationResult };

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
};

function withStatus(state: FormState, endpointId: string, status: StepStatus, patch: Partial<StepRecord> = {}) {
  const previous = state.records[endpointId] ?? { endpointId, values: {}, status: 'idle' as StepStatus };
  return { ...state.records, [endpointId]: { ...previous, ...patch, status } };
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

// After a successful step, go to the first step in flow order
// that isn't complete -- not simply index + 1, which stops being right once
// steps can be revisited. With every step complete, stay where we are.
function nextStepIndex(records: Record<string, StepRecord>, endpointIds: string[], current: number): number {
  const next = endpointIds.findIndex((id) => records[id]?.status !== 'complete');
  return next === -1 ? current : next;
}

function reducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'fatal':
      return { ...state, error: action.error };
    case 'stepEntered':
      return {
        ...state,
        loading: true,
        errors: {},
        executionError: null,
        suggestedValues: {},
        values: {},
        currentStepFields: action.fields,
      };
    case 'fieldsLoaded':
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
      const reopen = status === 'invalid' || status === 'executionFailed';
      return {
        ...state,
        values: { ...state.values, [action.name]: action.value },
        errors: reopen ? {} : state.errors,
        executionError: reopen ? null : state.executionError,
        records: reopen ? withStatus(state, action.endpointId, 'idle') : state.records,
        // New values make it a different logical operation.
        idempotencyKeys: withoutKey(state.idempotencyKeys, action.endpointId),
      };
    }
    case 'clientInvalid':
      return { ...state, errors: action.errors, records: withStatus(state, action.endpointId, 'invalid') };
    case 'validating':
      return { ...state, errors: {}, records: withStatus(state, action.endpointId, 'validating') };
    case 'serverInvalid':
      return { ...state, errors: action.errors, records: withStatus(state, action.endpointId, 'invalid') };
    case 'executing':
      return {
        ...state,
        executionError: null,
        records: withStatus(state, action.endpointId, 'executing'),
        idempotencyKeys: { ...state.idempotencyKeys, [action.endpointId]: action.idempotencyKey },
      };
    case 'createSucceeded': {
      const records = withStatus(state, action.endpointId, 'complete', { values: action.values, result: action.result });
      return {
        ...state,
        records,
        idempotencyKeys: withoutKey(state.idempotencyKeys, action.endpointId),
        currentStepIndex: nextStepIndex(records, action.endpointIds, state.currentStepIndex),
      };
    }
    case 'createFailed':
      return {
        ...state,
        executionError: action.result.message ?? 'execute() reported failure.',
        records: withStatus(state, action.endpointId, 'executionFailed', { values: action.values, result: action.result }),
      };
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

  // On entering a step, fetch its AI-adapted fields. If the
  // request itself fails (not the server's own graceful degradation, which
  // already comes back as a normal 200 -- see stepEngine.ts), fall back
  // client-side to the endpoint's full base field list, which the hook
  // already has from `flow`. Aborts on step change/unmount.
  useEffect(() => {
    if (!currentEndpoint) {
      dispatch({ type: 'fatal', error: new Error('useAgentForm: flow has no endpoints.') });
      return;
    }

    const controller = new AbortController();
    dispatch({ type: 'stepEntered', fields: currentEndpoint.fields });

    fetchStepFields(options.apiUrl, sessionIdRef.current!, currentEndpoint, controller.signal)
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

  const runCreate = useCallback(
    async (endpoint: EndpointDef, data: Record<string, unknown>) => {
      const current = stateRef.current;
      const idempotencyKey = current.idempotencyKeys[endpoint.id] ?? randomId();
      dispatch({ type: 'executing', endpointId: endpoint.id, idempotencyKey });

      const results: Record<string, OperationResult> = {};
      for (const record of Object.values(current.records)) {
        if (record.status === 'complete' && record.result) results[record.endpointId] = record.result;
      }
      const context: ExecContext = { getAuthHeaders: options.getAuthHeaders, results, idempotencyKey };

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
          result,
          endpointIds: flow.endpoints.map((e) => e.id),
        });
      } else {
        dispatch({ type: 'createFailed', endpointId: endpoint.id, values: data, result });
      }
    },
    [flow.endpoints, options.getAuthHeaders]
  );

  const submitStep = useCallback(async () => {
    if (!currentEndpoint) return;
    const { currentStepFields, values } = stateRef.current;

    const clientErrors = validateClientSide(currentStepFields, values);
    if (Object.keys(clientErrors).length > 0) {
      dispatch({ type: 'clientInvalid', endpointId: currentEndpoint.id, errors: clientErrors });
      return;
    }

    dispatch({ type: 'validating', endpointId: currentEndpoint.id });

    let valid = true;
    let serverErrors: Record<string, string> = {};
    try {
      const result = await postStepValidate(options.apiUrl, sessionIdRef.current!, currentEndpoint, values);
      valid = result.valid;
      serverErrors = result.errors;
    } catch (err) {
      // Client-side mirror of graceful degradation: the semantic
      // check itself couldn't be reached, so fall back to accepting the
      // client-side validation above as sufficient rather than blocking.
      console.warn(
        `useAgentForm: /api/step/validate failed for "${currentEndpoint.id}", accepting client-side validation only.`,
        err
      );
      valid = true;
    }

    if (!isMountedRef.current) return;

    if (!valid) {
      dispatch({ type: 'serverInvalid', endpointId: currentEndpoint.id, errors: serverErrors });
      return;
    }

    await runCreate(currentEndpoint, values);
  }, [currentEndpoint, options.apiUrl, runCreate]);

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
      dispatch({ type: 'fieldUpdated', endpointId: currentEndpoint.id, name: fieldName, value });
    },
    [currentEndpoint]
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
    error: state.error,
  };
}
