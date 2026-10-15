import type { OperationFailure } from './contracts.js';

export type FailureClassification = 'retryable' | 'needs-edit' | 'fundamental';

export interface RollbackReport {
  /** Steps whose undo succeeded, in the order they ran. */
  undone: string[];
  /** The undo that failed, which stopped the rollback. */
  failed?: { endpointId: string; failure?: OperationFailure; message?: string };
  /** Steps in the undo range that had no usable undo -- they need manual cleanup. */
  skipped: string[];
}

export type RecoveryEvent =
  | { type: 'classified'; endpointId: string; classification: FailureClassification; byModel: boolean }
  | { type: 'proposed'; endpointId: string; undo: string[]; skipped: string[] }
  | { type: 'confirmed'; endpointId: string }
  | { type: 'declined'; endpointId: string }
  | { type: 'undone'; endpointId: string }
  | { type: 'undoFailed'; endpointId: string; failure?: OperationFailure };

export interface PreClassification {
  /** 'ask' means the deterministic rules can't tell; the model decides (LLM #4). */
  verdict: 'retryable' | 'ask';
  explanation?: string;
}

const DUPLICATE_WARNING = " If the service doesn't support idempotency keys, retrying might create a duplicate.";

/**
 * The cases that never need judgment. Network problems,
 * timeouts, 5xx/408/429 and 401 are retryable; any other 4xx goes to the
 * model. A failure without a cause (`other`) is retried once before the model
 * is asked, since there is nothing to classify the first time.
 */
export function preClassify(failure: OperationFailure | undefined, previousOtherFailures: number): PreClassification {
  const kind = failure?.kind ?? 'other';

  if (kind === 'network') {
    return { verdict: 'retryable', explanation: "Couldn't reach the service. Check the connection and try again." + DUPLICATE_WARNING };
  }
  if (kind === 'timeout') {
    return { verdict: 'retryable', explanation: 'The service took too long to answer. Try again.' + DUPLICATE_WARNING };
  }
  if (kind === 'http') {
    const status = failure?.status;
    if (status === 401) return { verdict: 'retryable', explanation: 'Your session may have expired. Try again.' };
    if (status === 408) return { verdict: 'retryable', explanation: 'The service took too long to answer. Try again.' + DUPLICATE_WARNING };
    if (status === 429) return { verdict: 'retryable', explanation: 'Too many requests right now. Wait a moment and try again.' };
    if (status !== undefined && status >= 500) {
      return { verdict: 'retryable', explanation: 'The service had a temporary problem. Try again.' };
    }
    return { verdict: 'ask' };
  }
  return previousOtherFailures === 0 ? { verdict: 'retryable', explanation: 'Something went wrong. Try again.' } : { verdict: 'ask' };
}
