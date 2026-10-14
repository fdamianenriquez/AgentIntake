import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_WARNED_FLOW_IDS, runtimeGuidance, type ServerContext } from './serverContext.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('unknown flow id warnings (trusted flows on)', () => {
  it('warns once per id up to the cap, then once more, and stops growing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const context: ServerContext = { trustedFlows: new Map(), warnedFlowIds: new Set() };
    const res = { locals: { agentIntake: context } } as unknown as Response;

    for (let i = 0; i < MAX_WARNED_FLOW_IDS + 5; i++) {
      runtimeGuidance(res, 'validate', { id: `random-${i}` }, []);
      runtimeGuidance(res, 'validate', { id: `random-${i}` }, []); // repeats never warn again
    }

    expect(MAX_WARNED_FLOW_IDS).toBe(1000);
    expect(warn).toHaveBeenCalledTimes(MAX_WARNED_FLOW_IDS + 1);
    expect(String(warn.mock.calls.at(-1)![0])).toMatch(/further unknown flow ids are not reported/);
    expect(context.warnedFlowIds!.size).toBe(MAX_WARNED_FLOW_IDS);
  });
});
