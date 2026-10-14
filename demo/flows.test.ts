import { describe, expect, it } from 'vitest';
import { GeneratedFlowSchema } from '../packages/react-agent-intake/src/contracts.js';
import rawFlow from './flow.json' with { type: 'json' };
import rawGuidedFlow from './flow.guided.json' with { type: 'json' };

describe('the demo flows', () => {
  const plain = GeneratedFlowSchema.parse(rawFlow);
  const guided = GeneratedFlowSchema.parse(rawGuidedFlow);

  it('the guided flow is the default one plus author guidance', () => {
    const strip = ({ guidance: _g, ...endpoint }: (typeof guided.endpoints)[number]) => endpoint;
    expect(guided.endpoints.map(strip)).toEqual(plain.endpoints);
    expect(guided.id).not.toBe(plain.id);
  });

  it('sets flow guidance, guidance on at least two steps, and an output language', () => {
    expect(guided.guidance).toBeTruthy();
    expect(guided.outputLanguage).toBe('es-MX');
    expect(guided.endpoints.filter((endpoint) => endpoint.guidance).length).toBeGreaterThanOrEqual(2);
    expect(plain.guidance).toBeUndefined();
  });
});
