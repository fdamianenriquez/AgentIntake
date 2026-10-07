import { describe, expect, it } from 'vitest';
import type { OperationFailure } from './contracts.js';
import { preClassify } from './recovery.js';

describe('preClassify (one row per case)', () => {
  it.each<[string, OperationFailure | undefined, number, 'retryable' | 'ask']>([
    ['network', { kind: 'network' }, 0, 'retryable'],
    ['timeout', { kind: 'timeout' }, 0, 'retryable'],
    ['http 500', { kind: 'http', status: 500 }, 0, 'retryable'],
    ['http 503', { kind: 'http', status: 503 }, 0, 'retryable'],
    ['http 408', { kind: 'http', status: 408 }, 0, 'retryable'],
    ['http 429', { kind: 'http', status: 429 }, 0, 'retryable'],
    ['http 401', { kind: 'http', status: 401 }, 0, 'retryable'],
    ['http 400', { kind: 'http', status: 400 }, 0, 'ask'],
    ['http 403', { kind: 'http', status: 403 }, 0, 'ask'],
    ['http 409', { kind: 'http', status: 409 }, 0, 'ask'],
    ['http 422', { kind: 'http', status: 422 }, 0, 'ask'],
    ['http without status', { kind: 'http' }, 0, 'ask'],
    ['other, first time', { kind: 'other' }, 0, 'retryable'],
    ['other, again', { kind: 'other' }, 1, 'ask'],
    ['no failure info, first time', undefined, 0, 'retryable'],
    ['no failure info, again', undefined, 2, 'ask'],
  ])('%s -> %s', (_label, failure, previous, expected) => {
    expect(preClassify(failure, previous).verdict).toBe(expected);
  });

  it('warns about duplicates where a retry could re-run a create that did happen', () => {
    expect(preClassify({ kind: 'timeout' }, 0).explanation).toMatch(/duplicate/);
    expect(preClassify({ kind: 'network' }, 0).explanation).toMatch(/duplicate/);
    expect(preClassify({ kind: 'http', status: 429 }, 0).explanation).not.toMatch(/duplicate/);
  });
});
