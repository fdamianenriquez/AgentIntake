import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EndpointDef, FieldDef, FlowDef } from '../../../server/src/flowSchema.js';

// StepStatus (README: "The `StepStatus` lifecycle") is the single source of truth for a step's
// lifecycle -- never inferred from separate booleans. 'complete' is
// reserved exclusively for a successful execute(); a step that only passed
// semantic validation is 'executing' or 'executionFailed', never 'complete'.
export type StepStatus = 'idle' | 'validating' | 'invalid' | 'executing' | 'complete' | 'executionFailed';

export interface UseAgentFormOptions {
  apiUrl: string;
  // Not shown type snippet, but required direct-from-
  // browser auth pattern: "useAgentForm accepts an optional getAuthHeaders
  // ... that flows into execute()'s context argument." Included here to
  // actually satisfy that.
  getAuthHeaders?: () => Record<string, string>;
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
  // Not type snippet either, but requires a distinct signal for
  // "fetching this step's adapted fields," which currentStepStatus (about
  // submitStep(), not step entry) doesn't cover.
  loading: boolean;
  updateField: (fieldName: string, value: unknown) => void;
  submitStep: () => Promise<void>;
  retryExecution: () => Promise<void>;
  completedEndpoints: string[];
  isComplete: boolean;
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

function toWireEndpoint(endpoint: EndpointDef): Omit<EndpointDef, 'execute'> {
  const { execute: _execute, ...rest } = endpoint;
  return rest;
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

// crypto.randomUUID only exists in secure contexts (HTTPS or localhost);
// getRandomValues is available everywhere, so a plain-HTTP deployment still works.
function newSessionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function useAgentForm(flow: FlowDef, options: UseAgentFormOptions): UseAgentFormResult {
  const sessionIdRef = useRef<string | undefined>(undefined);
  if (!sessionIdRef.current) {
    sessionIdRef.current = newSessionId();
  }

  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [currentStepFields, setCurrentStepFields] = useState<FieldDef[]>([]);
  const [suggestedValues, setSuggestedValues] = useState<Record<string, unknown>>({});
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [stepStatuses, setStepStatuses] = useState<Record<string, StepStatus>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const currentEndpoint = flow.endpoints[currentStepIndex];

  const setStepStatus = useCallback((endpointId: string, status: StepStatus) => {
    setStepStatuses((prev) => ({ ...prev, [endpointId]: status }));
  }, []);

  // On entering a step, fetch its AI-adapted fields. If the
  // request itself fails (not the server's own graceful degradation, which
  // already comes back as a normal 200 -- see stepEngine.ts), fall back
  // client-side to the endpoint's full base field list, which the hook
  // already has from `flow`. Aborts on step change/unmount.
  useEffect(() => {
    if (!currentEndpoint) {
      setError(new Error('useAgentForm: flow has no endpoints.'));
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setErrors({});
    setExecutionError(null);
    setSuggestedValues({});
    setValues({});
    setCurrentStepFields(currentEndpoint.fields);

    fetchStepFields(options.apiUrl, sessionIdRef.current!, currentEndpoint, controller.signal)
      .then((result) => {
        setCurrentStepFields(result.fields);
        setSuggestedValues(result.suggestedValues);
        setValues((prev) => ({ ...result.suggestedValues, ...prev }));
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        console.warn(
          `useAgentForm: /api/step/fields failed for "${currentEndpoint.id}", falling back to the full base field list.`,
          err
        );
        setCurrentStepFields(currentEndpoint.fields);
        setSuggestedValues({});
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
    // Keyed on ids, not on the flow object: a host that rebuilds an equal flow
    // on every render (e.g. to attach execute functions) must not wipe what
    // the user has typed or trigger another LLM call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStepIndex, flow.id, currentEndpoint?.id, options.apiUrl]);

  const runExecute = useCallback(
    async (endpoint: EndpointDef, data: Record<string, unknown>) => {
      setStepStatus(endpoint.id, 'executing');
      setExecutionError(null);

      try {
        const result = await endpoint.execute(data, { getAuthHeaders: options.getAuthHeaders });
        if (!isMountedRef.current) return;

        if (result.success) {
          setStepStatus(endpoint.id, 'complete');
          setCurrentStepIndex((index) => Math.min(index + 1, flow.endpoints.length - 1));
        } else {
          setStepStatus(endpoint.id, 'executionFailed');
          setExecutionError(result.message ?? 'execute() reported failure.');
        }
      } catch (err) {
        if (!isMountedRef.current) return;
        setStepStatus(endpoint.id, 'executionFailed');
        setExecutionError(err instanceof Error ? err.message : String(err));
      }
    },
    [flow.endpoints.length, options.getAuthHeaders, setStepStatus]
  );

  const submitStep = useCallback(async () => {
    if (!currentEndpoint) return;

    const clientErrors = validateClientSide(currentStepFields, values);
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors);
      setStepStatus(currentEndpoint.id, 'invalid');
      return;
    }

    setStepStatus(currentEndpoint.id, 'validating');
    setErrors({});

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
      setErrors(serverErrors);
      setStepStatus(currentEndpoint.id, 'invalid');
      return;
    }

    await runExecute(currentEndpoint, values);
  }, [currentEndpoint, currentStepFields, values, options.apiUrl, runExecute, setStepStatus]);

  const retryExecution = useCallback(async () => {
    if (!currentEndpoint) return;
    if (stepStatuses[currentEndpoint.id] !== 'executionFailed') return;
    await runExecute(currentEndpoint, values);
  }, [currentEndpoint, stepStatuses, values, runExecute]);

  const updateField = useCallback(
    (fieldName: string, value: unknown) => {
      setValues((prev) => ({ ...prev, [fieldName]: value }));

      if (!currentEndpoint) return;
      const status = stepStatuses[currentEndpoint.id];
      if (status === 'invalid' || status === 'executionFailed') {
        setStepStatus(currentEndpoint.id, 'idle');
        setErrors({});
        setExecutionError(null);
      }
    },
    [currentEndpoint, stepStatuses, setStepStatus]
  );

  const completedEndpoints = useMemo(
    () => flow.endpoints.filter((endpoint) => stepStatuses[endpoint.id] === 'complete').map((endpoint) => endpoint.id),
    [flow.endpoints, stepStatuses]
  );

  const isComplete = completedEndpoints.length === flow.endpoints.length;
  const currentStepStatus: StepStatus = currentEndpoint ? stepStatuses[currentEndpoint.id] ?? 'idle' : 'idle';

  return {
    currentStepIndex,
    totalSteps: flow.endpoints.length,
    currentStepFields,
    suggestedValues,
    values,
    errors,
    currentStepStatus,
    executionError,
    loading,
    updateField,
    submitStep,
    retryExecution,
    completedEndpoints,
    isComplete,
    error,
  };
}
