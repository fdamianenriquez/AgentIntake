import { randomUUID } from 'node:crypto';

// In-memory Map<sessionId, CollectedData> (session state is v1 scope;
// persistence beyond memory is out of scope). Deliberately minimal: this module only stores/retrieves data,
// it has no notion of a flow's full endpoint list or "is the wizard done" --
// that's for whoever wires sessions into routes/the hook to
// decide, since it requires knowing the flow definition this store doesn't.
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
}

const sessions = new Map<string, SessionState>();

export function createSession(): SessionState {
  const session: SessionState = {
    id: randomUUID(),
    collectedData: {},
    validatedEndpointIds: [],
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
    validatedEndpointIds: [],
    createdAt: Date.now(),
  };
  sessions.set(session.id, session);
  return session;
}

export function recordValidatedStep(
  sessionId: string,
  endpointId: string,
  data: Record<string, unknown>
): SessionState {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`sessionStore: no session found for id "${sessionId}"`);
  }
  session.collectedData[endpointId] = data;
  if (!session.validatedEndpointIds.includes(endpointId)) {
    session.validatedEndpointIds.push(endpointId);
  }
  return session;
}

export function isEndpointValidated(sessionId: string, endpointId: string): boolean {
  return getSession(sessionId)?.validatedEndpointIds.includes(endpointId) ?? false;
}

export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
}
