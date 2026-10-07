import type { FlowDef } from '../../packages/react-agent-intake/src/contracts.js';

// Hand-written, not LLM-generated: a minimal single-endpoint flow used to
// sanity-check that the FlowDef/EndpointDef/FieldDef shapes are usable before
// any OpenAPI parsing or generation exists (see flowSchema.test.ts).
export const exampleFlow: FlowDef = {
  id: 'newsletter-signup',
  title: 'Newsletter Signup',
  description: 'Subscribe to the product newsletter.',
  endpoints: [
    {
      id: 'subscribe',
      title: 'Subscribe',
      description: 'Create a new newsletter subscription.',
      fields: [
        {
          name: 'email',
          type: 'string',
          label: 'Email address',
          required: true,
          validation: {
            pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
          },
        },
        {
          name: 'name',
          type: 'string',
          label: 'Full name',
          required: false,
        },
        {
          name: 'frequency',
          type: 'enum',
          label: 'Email frequency',
          description: 'How often should we send updates?',
          required: true,
          enumValues: ['weekly', 'monthly'],
        },
      ],
      auth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
      },
      execute: async (data, _context) => {
        console.log('Would call POST /subscribers with:', data);
        return { success: true };
      },
    },
  ],
};
