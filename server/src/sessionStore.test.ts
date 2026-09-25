import { describe, expect, it } from 'vitest';
import {
  createSession,
  deleteSession,
  getOrCreateSession,
  getSession,
  isEndpointValidated,
  recordValidatedStep,
} from './sessionStore.js';

describe('sessionStore', () => {
  it('creates a session with a unique id and empty state', () => {
    const a = createSession();
    const b = createSession();

    expect(a.id).not.toBe(b.id);
    expect(a.collectedData).toEqual({});
    expect(a.validatedEndpointIds).toEqual([]);
  });

  it('retrieves a session by id, and returns undefined for an unknown one', () => {
    const session = createSession();
    expect(getSession(session.id)).toEqual(session);
    expect(getSession('does-not-exist')).toBeUndefined();
  });

  it('records a validated step, storing data and marking the endpoint validated', () => {
    const session = createSession();
    recordValidatedStep(session.id, 'createCandidate', { email: 'a@b.com' });

    const updated = getSession(session.id)!;
    expect(updated.collectedData.createCandidate).toEqual({ email: 'a@b.com' });
    expect(updated.validatedEndpointIds).toEqual(['createCandidate']);
    expect(isEndpointValidated(session.id, 'createCandidate')).toBe(true);
    expect(isEndpointValidated(session.id, 'otherEndpoint')).toBe(false);
  });

  it('does not duplicate an endpoint id when the same step is recorded twice', () => {
    const session = createSession();
    recordValidatedStep(session.id, 'createCandidate', { email: 'a@b.com' });
    recordValidatedStep(session.id, 'createCandidate', { email: 'updated@b.com' });

    const updated = getSession(session.id)!;
    expect(updated.validatedEndpointIds).toEqual(['createCandidate']);
    expect(updated.collectedData.createCandidate).toEqual({ email: 'updated@b.com' });
  });

  it('throws a clear error when recording a validated step for an unknown session', () => {
    expect(() => recordValidatedStep('does-not-exist', 'createCandidate', {})).toThrow(
      /no session found/
    );
  });

  it('deletes a session', () => {
    const session = createSession();
    deleteSession(session.id);
    expect(getSession(session.id)).toBeUndefined();
  });

  it('getOrCreateSession creates a session under a client-supplied id on first use', () => {
    const session = getOrCreateSession('client-generated-id-123');

    expect(session.id).toBe('client-generated-id-123');
    expect(session.collectedData).toEqual({});
    expect(getSession('client-generated-id-123')).toEqual(session);
  });

  it('getOrCreateSession returns the existing session on subsequent calls', () => {
    const first = getOrCreateSession('same-id');
    recordValidatedStep('same-id', 'createCandidate', { email: 'a@b.com' });

    const second = getOrCreateSession('same-id');

    expect(second).toBe(first);
    expect(second.collectedData.createCandidate).toEqual({ email: 'a@b.com' });
  });
});
