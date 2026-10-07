import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSession,
  deleteSession,
  getOrCreateSession,
  getScopedData,
  getSession,
  isEndpointValidated,
  MAX_SESSIONS,
  recordValidatedStep,
  replaceStepData,
  SESSION_IDLE_TTL_MS,
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

  it('isEndpointValidated returns false (not a throw) for a session that does not exist at all', () => {
    expect(isEndpointValidated('does-not-exist', 'createCandidate')).toBe(false);
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

describe('sessionStore bounds', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('expires a session after SESSION_IDLE_TTL_MS without access', () => {
    vi.useFakeTimers();
    const session = getOrCreateSession('idle-session');

    vi.advanceTimersByTime(SESSION_IDLE_TTL_MS + 1);

    expect(getSession(session.id)).toBeUndefined();
  });

  it('keeps a session alive while it keeps being accessed', () => {
    vi.useFakeTimers();
    getOrCreateSession('active-session');

    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(SESSION_IDLE_TTL_MS - 1000);
      expect(getSession('active-session')).toBeDefined();
    }
  });

  it('never holds more than MAX_SESSIONS, evicting the least recently used first', () => {
    getOrCreateSession('lru-oldest');
    getOrCreateSession('lru-kept');
    for (let i = 0; i < MAX_SESSIONS; i++) {
      getOrCreateSession(`lru-filler-${i}`);
      if (i === 0) getSession('lru-kept'); // touched, so it moves behind 'lru-oldest'
    }

    expect(getSession('lru-oldest')).toBeUndefined();
    expect(getSession('lru-kept')).toBeDefined();
    expect(getSession(`lru-filler-${MAX_SESSIONS - 1}`)).toBeDefined();
  });
});

describe('scoped data and step replacement', () => {
  it('getScopedData returns only the requested steps', () => {
    getOrCreateSession('scope-a');
    recordValidatedStep('scope-a', 'one', { x: 1 });
    recordValidatedStep('scope-a', 'two', { y: 2 });

    expect(getScopedData('scope-a', ['one', 'missing'])).toEqual({ one: { x: 1 } });
    expect(getScopedData('no-such-session', ['one'])).toEqual({});
  });

  it('replaceStepData overwrites and forgets steps', () => {
    getOrCreateSession('replace-a');
    recordValidatedStep('replace-a', 'one', { x: 1 });

    replaceStepData('replace-a', [
      { endpointId: 'one', data: null },
      { endpointId: 'two', data: { y: 2 } },
    ]);

    expect(getSession('replace-a')?.collectedData).toEqual({ two: { y: 2 } });
    expect(getSession('replace-a')?.validatedEndpointIds).toEqual(['two']);
  });
});
