import type { EndpointCapabilities, EndpointDef, OperationFailure, OperationResult, ResourceOperations } from './contracts.js';

const MAX_FAILURE_MESSAGE_LENGTH = 500;

/**
 * Builds an OperationFailure from a fetch Response, so a flow author can report
 * a real HTTP status in one line: `return { success: false, failure: await failureFromResponse(res) }`.
 * Without a status, a failure can only be classified as `other`.
 */
export async function failureFromResponse(response: Response): Promise<OperationFailure> {
  let message: string | undefined;
  try {
    message = (await response.text()).slice(0, MAX_FAILURE_MESSAGE_LENGTH) || undefined;
  } catch {
    message = undefined;
  }
  return { kind: 'http', status: response.status, message };
}

/**
 * Maps the response of an undo request (typically a DELETE) to an
 * OperationResult. 2xx, 404 and 410 all mean the resource is gone -- which is
 * what an undo wants -- so they count as success. Without that, an undo whose
 * response was lost (the server deleted, the client never heard back) would
 * fail forever on retry. Any other status is a failure with its details.
 * AgentIntake doesn't apply this itself: only the author knows their API's semantics.
 */
export async function undoResultFromResponse(response: Response): Promise<OperationResult> {
  if (response.ok || response.status === 404 || response.status === 410) return { success: true };
  return {
    success: false,
    message: `The undo was answered with ${response.status}.`,
    failure: await failureFromResponse(response),
  };
}

/** `execute` (the v1.0 API) is exactly `operations.create`. */
export function operationsOf(endpoint: EndpointDef): ResourceOperations {
  if (endpoint.operations) return endpoint.operations;
  return { create: endpoint.execute };
}

/** The operations the author actually implemented -- this, not the parser's hints, is what runs. */
export function implementedCapabilities(endpoint: EndpointDef): EndpointCapabilities {
  const ops = operationsOf(endpoint);
  return { read: Boolean(ops.read), update: Boolean(ops.update), undo: Boolean(ops.undo) };
}

/**
 * Turns whatever an operation returned (or threw) into a well-formed
 * OperationResult: a failed result always carries a `failure`, a successful one
 * never does.
 */
export function normalizeResult(value: unknown): OperationResult {
  if (typeof value !== 'object' || value === null || typeof (value as OperationResult).success !== 'boolean') {
    return {
      success: false,
      message: 'The operation returned an invalid result.',
      failure: { kind: 'other', message: 'Expected an object with a boolean "success".' },
    };
  }

  const result = value as OperationResult;
  if (result.success) {
    const { failure: _failure, ...rest } = result;
    return rest;
  }
  return { ...result, failure: result.failure ?? { kind: 'other', message: result.message } };
}

export function resultFromError(error: unknown): OperationResult {
  const message = error instanceof Error ? error.message : String(error);
  return { success: false, message, failure: { kind: 'other', message } };
}
