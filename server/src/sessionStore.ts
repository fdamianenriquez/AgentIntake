import { randomUUID } from 'node:crypto';

// In-memory Map<sessionId, CollectedData> (session state is v1 scope;
// persistence beyond memory is out of scope). Deliberately minimal: this module only stores/retrieves data,
// it has no notion of a flow's full endpoint list or "is the wizard done" --
// that's for whoever wires sessions into routes/the hook to
// decide, since it requires knowing the flow definition this store doesn't.

export interface SessionState {
  id: string;
  collectedData: Record<string, Record<string, unknown>>;
  completedEndpointIds: string[];
  createdAt: number;
}

const sessions = new Map<string, SessionState>();

export function createSession(): SessionState {
  const session: SessionState = {
    id: randomUUID(),
    collectedData: {},
    completedEndpointIds: [],
    createdAt: Date.now(),
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(sessionId: string): SessionState | undefined {
  return sessions.get(sessionId);
}

// The client (useAgentForm, which manages sessionId internally) generates
// its own session id and sends it with every request -- there's no
// separate "create session" round-trip in the routes. Routes use
// this to lazily create a session on first reference, keyed by whatever id
// the client supplied, instead of requiring it to already exist.
export function getOrCreateSession(sessionId: string): SessionState {
  const existing = sessions.get(sessionId);
  if (existing) return existing;

  const session: SessionState = {
    id: sessionId,
    collectedData: {},
    completedEndpointIds: [],
    createdAt: Date.now(),
  };
  sessions.set(session.id, session);
  return session;
}

export function recordStepCompletion(
  sessionId: string,
  endpointId: string,
  data: Record<string, unknown>
): SessionState {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`sessionStore: no session found for id "${sessionId}"`);
  }
  session.collectedData[endpointId] = data;
  if (!session.completedEndpointIds.includes(endpointId)) {
    session.completedEndpointIds.push(endpointId);
  }
  return session;
}

export function isEndpointCompleted(sessionId: string, endpointId: string): boolean {
  return getSession(sessionId)?.completedEndpointIds.includes(endpointId) ?? false;
}

export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
}
