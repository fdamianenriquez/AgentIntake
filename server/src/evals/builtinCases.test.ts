import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { caseEndpoints, EVAL_CALLS, loadCases, type EvalCase } from './cases.js';

// The built-in suite in evals/cases is part of the repo, so it is checked
// like code: every file valid, and every name an expectation uses present in
// the case's own input. Running it against a model is `agent-intake
// eval-prompts`, never part of npm test.
const dir = fileURLToPath(new URL('../../../evals/cases', import.meta.url));
const cases = loadCases(dir);
const byCall = (call: string) => cases.filter((c) => c.call === call);

function namesUsed(c: EvalCase): { fields: string[]; steps: string[] } {
  const lists = (o: { mustInclude?: string[]; mustExclude?: string[] } | undefined) => [
    ...(o?.mustInclude ?? []),
    ...(o?.mustExclude ?? []),
  ];
  switch (c.call) {
    case 'generation':
      return { fields: lists((c as EvalCase<'generation'>).expect.ambiguousFields), steps: [] };
    case 'selectFields':
      return { fields: lists((c as EvalCase<'selectFields'>).expect), steps: [] };
    case 'validate':
      return { fields: (c as EvalCase<'validate'>).expect.errorFields?.fields ?? [], steps: [] };
    case 'invalidation': {
      const e = (c as EvalCase<'invalidation'>).expect;
      return { fields: [], steps: 'affected' in e ? e.affected : lists(e) };
    }
    case 'classifyFailure': {
      const e = (c as EvalCase<'classifyFailure'>).expect;
      return { fields: [], steps: e.rollbackFromEndpointId ? [e.rollbackFromEndpointId] : [] };
    }
  }
}

function namesAvailable(c: EvalCase): { fields: Set<string>; steps: Set<string> } {
  const { subjects, others } = caseEndpoints(c);
  return {
    fields: new Set(subjects.flatMap((endpoint) => endpoint.fields.map((field) => field.name))),
    steps: new Set(others.map((endpoint) => endpoint.id)),
  };
}

describe('built-in eval suite', () => {
  it('has at least 6 cases per call (3 for generation)', () => {
    for (const call of EVAL_CALLS) expect(byCall(call).length, call).toBeGreaterThanOrEqual(call === 'generation' ? 3 : 6);
  });

  it('has a guidance-dependent case per call, with its fixtures and a note saying so', () => {
    for (const call of EVAL_CALLS) {
      const guided = byCall(call).filter((c) => c.fixtures);
      expect(guided.length, call).toBeGreaterThanOrEqual(1);
      for (const c of guided) expect(c.notes, c.file).toMatch(/Guidance-dependent/);
    }
  });

  it.each(cases.map((c) => [c.file.slice(dir.length + 1), c]))('%s: every name it expects is in its input', (_file, c) => {
    const used = namesUsed(c);
    const available = namesAvailable(c);
    for (const field of used.fields) expect(available.fields, `field ${field}`).toContain(field);
    for (const step of used.steps) expect(available.steps, `step ${step}`).toContain(step);
  });
});
