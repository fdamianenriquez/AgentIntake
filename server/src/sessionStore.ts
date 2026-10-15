import { randomUUID } from 'node:crypto';

// In-memory Map<sessionId, CollectedData> (persistence across restarts is
// out of scope; README: "Known operational boundaries"). Deliberately
// minimal: this module only stores/retrieves data, it has no notion of a
// flow's full endpoint list or "is the wizard done" -- that's for the routes
// and the hook to decide, since it requires knowing the flow definition this store doesn't.
//
// Naming note: this store only ever knows whether a step's data passed
// semantic validation -- it has no way to know whether the client's
// execute() (which runs client-side) ever ran or succeeded.
// "validatedEndpointIds" reflects that limitation on purpose; it must never
// be called "completedEndpointIds" or similar, since "completed" is the
// client's StepStatus === 'complete', a strictly stronger claim this store
// cannot make.

export interface SessionState {
  id: string;
  collectedData: Record<string, Record<string, unknown>>;
  validatedEndpointIds: string[];
  createdAt: number;
  lastAccessedAt: number;
}

// Session ids come from unauthenticated clients, so without bounds the map
// grows for the life of the process. Eviction is lazy (on access), so there is
// no timer to keep the process alive. The Map's insertion order is kept as
// least-recently-used first by re-inserting on every access.
export const SESSION_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
export const MAX_SESSIONS = 10_000;

const sessions = new Map<string, SessionState>();

function touch(session: SessionState): SessionState {
  session.lastAccessedAt = Date.now();
  sessions.delete(session.id);
  sessions.set(session.id, session);
  return session;
}

function evictStale(): void {
  const cutoff = Date.now() - SESSION_IDLE_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.lastAccessedAt >= cutoff) break;
    sessions.delete(id);
  }
  for (const id of sessions.keys()) {
    if (sessions.size <= MAX_SESSIONS) break;
    sessions.delete(id);
  }
}

function newSession(id: string): SessionState {
  evictStale();
  const now = Date.now();
  const session: SessionState = { id, collectedData: {}, validatedEndpointIds: [], createdAt: now, lastAccessedAt: now };
  sessions.set(id, session);
  evictStale();
  return session;
}

export function createSession(): SessionState {
  return newSession(randomUUID());
}

export function getSession(sessionId: string): SessionState | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  if (session.lastAccessedAt < Date.now() - SESSION_IDLE_TTL_MS) {
    sessions.delete(sessionId);
    return undefined;
  }
  return touch(session);
}

// The client (useAgentForm, which manages sessionId internally) generates
// its own session id and sends it with every request -- there's no
// separate "create session" round-trip in the routes. Routes use
// this to lazily create a session on first reference, keyed by whatever id
// the client supplied, instead of requiring it to already exist.
export function getOrCreateSession(sessionId: string): SessionState {
  return getSession(sessionId) ?? newSession(sessionId);
}

export function recordValidatedStep(
  sessionId: string,
  endpointId: string,
  data: Record<string, unknown>
): SessionState {
  const session = getSession(sessionId);
  if (!session) {
    throw new Error(`sessionStore: no session found for id "${sessionId}"`);
  }
  session.collectedData[endpointId] = data;
  if (!session.validatedEndpointIds.includes(endpointId)) {
    session.validatedEndpointIds.push(endpointId);
  }
  return session;
}

// After back-navigation the session holds data from steps
// that come *after* the one being shown; prompts for a step must only see the
// steps before it.
export function getScopedData(sessionId: string, endpointIds: string[]): Record<string, Record<string, unknown>> {
  const collected = getSession(sessionId)?.collectedData ?? {};
  const scoped: Record<string, Record<string, unknown>> = {};
  for (const id of endpointIds) {
    if (collected[id]) scoped[id] = collected[id];
  }
  return scoped;
}

/**
 * Overwrites what the session knows about the given steps: `data` replaces a
 * step's collected data, `null` forgets the step. Used when the client
 * discards an edit (so the server matches what was actually submitted) and,
 * later, after a rollback.
 */
export function replaceStepData(
  sessionId: string,
  steps: { endpointId: string; data: Record<string, unknown> | null }[]
): SessionState {
  const session = getOrCreateSession(sessionId);
  for (const { endpointId, data } of steps) {
    if (data === null) {
      delete session.collectedData[endpointId];
      session.validatedEndpointIds = session.validatedEndpointIds.filter((id) => id !== endpointId);
    } else {
      session.collectedData[endpointId] = data;
      if (!session.validatedEndpointIds.includes(endpointId)) session.validatedEndpointIds.push(endpointId);
    }
  }
  return session;
}

export function isEndpointValidated(sessionId: string, endpointId: string): boolean {
  return getSession(sessionId)?.validatedEndpointIds.includes(endpointId) ?? false;
}

export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
}
