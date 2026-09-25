import { describe, expect, it } from 'vitest';
import {
  createSession,
  deleteSession,
  getSession,
  isEndpointCompleted,
  recordStepCompletion,
} from './sessionStore.js';

describe('sessionStore', () => {
  it('creates a session with a unique id and empty state', () => {
    const a = createSession();
    const b = createSession();

    expect(a.id).not.toBe(b.id);
    expect(a.collectedData).toEqual({});
    expect(a.completedEndpointIds).toEqual([]);
  });

  it('retrieves a session by id, and returns undefined for an unknown one', () => {
    const session = createSession();
    expect(getSession(session.id)).toEqual(session);
    expect(getSession('does-not-exist')).toBeUndefined();
  });

  it('records step completion, storing data and marking the endpoint completed', () => {
    const session = createSession();
    recordStepCompletion(session.id, 'createCandidate', { email: 'a@b.com' });

    const updated = getSession(session.id)!;
    expect(updated.collectedData.createCandidate).toEqual({ email: 'a@b.com' });
    expect(updated.completedEndpointIds).toEqual(['createCandidate']);
    expect(isEndpointCompleted(session.id, 'createCandidate')).toBe(true);
    expect(isEndpointCompleted(session.id, 'otherEndpoint')).toBe(false);
  });

  it('does not duplicate an endpoint id when the same step is recorded twice', () => {
    const session = createSession();
    recordStepCompletion(session.id, 'createCandidate', { email: 'a@b.com' });
    recordStepCompletion(session.id, 'createCandidate', { email: 'updated@b.com' });

    const updated = getSession(session.id)!;
    expect(updated.completedEndpointIds).toEqual(['createCandidate']);
    expect(updated.collectedData.createCandidate).toEqual({ email: 'updated@b.com' });
  });

  it('throws a clear error when recording completion for an unknown session', () => {
    expect(() => recordStepCompletion('does-not-exist', 'createCandidate', {})).toThrow(
      /no session found/
    );
  });

  it('deletes a session', () => {
    const session = createSession();
    deleteSession(session.id);
    expect(getSession(session.id)).toBeUndefined();
  });
});
