import { describe, expect, it } from 'vitest';
import type { EndpointDef } from './contracts.js';
import { failureFromResponse, implementedCapabilities, normalizeResult, operationsOf, undoResultFromResponse } from './operations.js';

describe('failureFromResponse', () => {
  it('captures the HTTP status and body', async () => {
    const failure = await failureFromResponse(new Response('account on compliance hold', { status: 403 }));
    expect(failure).toEqual({ kind: 'http', status: 403, message: 'account on compliance hold' });
  });

  it('caps the body at 500 characters, since it is untrusted text that may reach an LLM prompt', async () => {
    const failure = await failureFromResponse(new Response('x'.repeat(2000), { status: 400 }));
    expect(failure.message).toHaveLength(500);
  });

  it('omits the message when the body is empty or unreadable', async () => {
    expect(await failureFromResponse(new Response(null, { status: 503 }))).toEqual({ kind: 'http', status: 503 });
    const used = new Response('read once', { status: 500 });
    await used.text();
    expect(await failureFromResponse(used)).toEqual({ kind: 'http', status: 500, message: undefined });
  });
});

describe('normalizeResult', () => {
  it('adds a failure of kind "other" when a failed result has none', () => {
    expect(normalizeResult({ success: false, message: 'Nope.' })).toEqual({
      success: false,
      message: 'Nope.',
      failure: { kind: 'other', message: 'Nope.' },
    });
  });

  it('keeps an explicit failure', () => {
    const failure = { kind: 'http' as const, status: 409 };
    expect(normalizeResult({ success: false, failure })).toEqual({ success: false, failure });
  });

  it('strips a failure from a successful result', () => {
    expect(normalizeResult({ success: true, resourceId: 'a', failure: { kind: 'other' } })).toEqual({
      success: true,
      resourceId: 'a',
    });
  });

  it('treats a malformed return value as a failure instead of crashing', () => {
    expect(normalizeResult(undefined)).toMatchObject({ success: false, failure: { kind: 'other' } });
    expect(normalizeResult({ ok: true })).toMatchObject({ success: false, failure: { kind: 'other' } });
  });
});

describe('operationsOf / implementedCapabilities', () => {
  const fn = async () => ({ success: true });

  it('treats execute as operations.create', () => {
    const endpoint: EndpointDef = { id: 'e', title: 'E', fields: [], execute: fn };
    expect(operationsOf(endpoint)).toEqual({ create: fn });
    expect(implementedCapabilities(endpoint)).toEqual({ read: false, update: false, undo: false });
  });

  it('reports exactly the operations the author implemented', () => {
    const endpoint: EndpointDef = { id: 'e', title: 'E', fields: [], operations: { create: fn, update: fn } };
    expect(implementedCapabilities(endpoint)).toEqual({ read: false, update: true, undo: false });
  });
});

describe('undoResultFromResponse', () => {
  it.each([204, 200, 404, 410])('treats %s as success (the resource is gone, which is what undo wants)', async (status) => {
    expect(await undoResultFromResponse(new Response(null, { status }))).toEqual({ success: true });
  });

  it.each([403, 500])('treats %s as a failure, with the status and body', async (status) => {
    expect(await undoResultFromResponse(new Response('not allowed', { status }))).toEqual({
      success: false,
      message: `The undo was answered with ${status}.`,
      failure: { kind: 'http', status, message: 'not allowed' },
    });
  });
});
