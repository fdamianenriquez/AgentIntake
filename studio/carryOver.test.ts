import { describe, expect, it } from 'vitest';
import { carryOverGuidance } from './carryOver.js';

const flow = (endpoints: { id: string; title: string; guidance?: string }[], extra = {}) => ({
  id: 'f',
  title: 'F',
  description: 'd',
  endpoints: endpoints.map((endpoint) => ({ ...endpoint, fields: [] })),
  ...extra,
});

describe('carryOverGuidance', () => {
  it('keeps flow guidance and language, and step guidance by endpoint id; reports steps that are gone', () => {
    const previous = flow(
      [
        { id: 'a', title: 'Account', guidance: 'A guidance.' },
        { id: 'gone', title: 'Old Step', guidance: 'Gone guidance.' },
        { id: 'b', title: 'Payout' },
      ],
      { guidance: 'Flow guidance.', outputLanguage: 'es-MX' }
    );
    const next = flow([
      { id: 'a', title: 'Your Account' },
      { id: 'b', title: 'Payout' },
      { id: 'c', title: 'New Step' },
    ]);

    const { flow: merged, droppedSteps } = carryOverGuidance(previous, next);

    expect(merged.guidance).toBe('Flow guidance.');
    expect(merged.outputLanguage).toBe('es-MX');
    expect(merged.endpoints.map((e) => [e.id, e.title, e.guidance])).toEqual([
      ['a', 'Your Account', 'A guidance.'],
      ['b', 'Payout', undefined],
      ['c', 'New Step', undefined],
    ]);
    expect(droppedSteps).toEqual(['Old Step']);
  });

  it('changes nothing when there was no guidance', () => {
    const next = flow([{ id: 'a', title: 'A' }]);
    expect(carryOverGuidance(flow([{ id: 'a', title: 'A' }]), next)).toEqual({ flow: next, droppedSteps: [] });
  });
});
