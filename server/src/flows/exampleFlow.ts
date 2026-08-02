import type { FlowDef } from '../flowSchema.js';

export const jobApplicationIntakeFlow: FlowDef = {
  id: 'job_application_intake',
  title: 'Job Application Intake',
  description:
    'Collect the information needed to submit a job application: candidate details, work preferences, and availability. Replace a typical multi-page job application form with a single conversation.',
  endpoints: [
    {
      id: 'submit_candidate_info',
      description: 'Submit the candidate personal information.',
      fields: [
        {
          name: 'full_name',
          type: 'string',
          description: 'The candidate full name.',
          required: true,
          validation: { min: 2, max: 100 },
        },
        {
          name: 'email',
          type: 'string',
          description: 'The candidate email address.',
          required: true,
          validation: { pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' },
        },
        {
          name: 'years_of_experience',
          type: 'number',
          description: 'Total years of professional experience.',
          required: true,
          validation: { min: 0, max: 50 },
        },
        {
          name: 'current_location',
          type: 'string',
          description: 'City and country where the candidate is currently based.',
          required: true,
        },
      ],
      execute: async (data) => {
        console.log('[execute] submit_candidate_info', data);
        return { success: true, message: 'Candidate info received.' };
      },
    },
    {
      id: 'submit_work_preferences',
      description: 'Submit the candidate desired role, working arrangement, and salary expectations.',
      fields: [
        {
          name: 'desired_role',
          type: 'string',
          description: 'The title of the role the candidate is applying for.',
          required: true,
        },
        {
          name: 'work_arrangement',
          type: 'enum',
          description: 'Preferred working arrangement.',
          required: true,
          enumValues: ['remote', 'hybrid', 'onsite'],
        },
        {
          name: 'salary_expectation_min',
          type: 'number',
          description: 'Minimum acceptable annual salary in USD.',
          required: false,
          validation: { min: 0 },
        },
        {
          name: 'salary_expectation_max',
          type: 'number',
          description: 'Maximum acceptable annual salary in USD.',
          required: false,
          validation: { min: 0 },
        },
      ],
      execute: async (data) => {
        console.log('[execute] submit_work_preferences', data);
        return { success: true, message: 'Work preferences received.' };
      },
    },
    {
      id: 'submit_availability',
      description: 'Submit the candidate earliest start date and notice period.',
      fields: [
        {
          name: 'earliest_start_date',
          type: 'date',
          description: 'The earliest date the candidate can start.',
          required: true,
        },
        {
          name: 'notice_period_weeks',
          type: 'number',
          description: 'Notice period in weeks for the current role.',
          required: true,
          validation: { min: 0, max: 52 },
        },
      ],
      execute: async (data) => {
        console.log('[execute] submit_availability', data);
        return { success: true, message: 'Availability received.' };
      },
    },
  ],
};

export const flows: Record<string, FlowDef> = {
  [jobApplicationIntakeFlow.id]: jobApplicationIntakeFlow,
};
