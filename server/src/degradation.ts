import { AsyncLocalStorage } from 'node:async_hooks';

// Why the engine fell back to its safe path (timeout, invalid output,
// provider error), for whoever is listening: today, the eval runner, which
// records the reason per run. The capture lives in an async context, so runs
// that overlap -- in one process, or two eval jobs at once -- each see only
// their own reports, and nothing global is patched.

export interface Degradation {
  call: string;
  endpointId: string;
  message: string;
}

const capture = new AsyncLocalStorage<Degradation[]>();

/** Runs `fn`, collecting every degradation reported inside it (and in what it awaits). */
export async function withDegradationCapture<T>(fn: () => Promise<T>): Promise<{ result: T; degradations: Degradation[] }> {
  const degradations: Degradation[] = [];
  const result = await capture.run(degradations, fn);
  return { result, degradations };
}

/** Records a degradation; returns true when a capture took it (so the caller need not log it). */
export function reportDegradation(call: string, endpointId: string, message: string): boolean {
  const store = capture.getStore();
  if (!store) return false;
  store.push({ call, endpointId, message });
  return true;
}
