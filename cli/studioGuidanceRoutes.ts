import { randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express, { type Express } from 'express';
import { z } from 'zod';
import { GeneratedFlowSchema, GUIDANCE_LIMITS, type GeneratedFlow } from '../packages/react-agent-intake/src/contracts.js';
import { AgentIntakeConfigSchema, type AgentIntakeConfig } from '../server/src/config.js';
import { EVAL_CALLS, loadCases, type EvalCall } from '../server/src/evals/cases.js';
import { countRuns, runEvals, type EvalReport } from '../server/src/evals/runEvals.js';
import { buildModel, resolveModelId, resolveProvider } from '../server/src/llmClient.js';
import * as classifyFailurePrompt from '../server/src/prompts/classifyFailure.js';
import * as generationPrompt from '../server/src/prompts/generation.js';
import { guidanceFor, renderGuidance, type PromptGuidance } from '../server/src/prompts/guidance.js';
import * as invalidationPrompt from '../server/src/prompts/invalidation.js';
import * as selectFieldsPrompt from '../server/src/prompts/selectFields.js';
import * as validatePrompt from '../server/src/prompts/validate.js';
import { isStaticMode } from '../server/src/stepEngine.js';
import { builtinCasesDir } from './commands/evalPrompts.js';
import type { StudioConfigStore } from './studioConfig.js';

// Studio-only routes for the Instructions tab. Like provider
// setup, they write to disk and spend model calls on request, so they live
// here, mounted only by the local `studio` command behind localOnlyGuard --
// never in createApp(), which a deployer may expose.

type ValidationIssue = { path: string; message: string };
const issuesOf = (error: z.ZodError): ValidationIssue[] =>
  error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Empty form fields mean "not set": they are dropped before validation, so an
// empty output language isn't an invalid language tag.
function withoutEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => (typeof item === 'string' ? item.trim() : item)).filter((item) => item !== '');
    return items.length > 0 ? items : undefined;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .map(([key, inner]) => [key, withoutEmpty(inner)] as const)
      .filter(([, inner]) => inner !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  return value;
}

/** Writes next to the target and renames over it, so the file is never left half-written. */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, content, 'utf-8');
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Render a prompt, as a runtime call would build it
// ---------------------------------------------------------------------------

const RenderPromptSchema = z
  .object({
    call: z.enum(EVAL_CALLS),
    flow: GeneratedFlowSchema,
    /** The step to render the prompt for (ignored for generation). */
    endpointId: z.string().optional(),
    /** Example submitted values, for validate. */
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

function renderPrompt(
  call: EvalCall,
  flow: GeneratedFlow,
  endpointId: string | undefined,
  data: Record<string, unknown>,
  config: AgentIntakeConfig | null
): { prompt: string; guidanceRange: { start: number; end: number } | null } {
  const flowGuidance = { guidance: flow.guidance, outputLanguage: flow.outputLanguage };
  const index = flow.endpoints.findIndex((endpoint) => endpoint.id === endpointId);
  if (call !== 'generation' && index === -1) throw new RangeError(`The flow has no step "${endpointId}".`);
  const endpoint = flow.endpoints[index];
  const narrow = (steps: GeneratedFlow['endpoints']): PromptGuidance | undefined =>
    guidanceFor(call, config?.guidance, flowGuidance, steps);

  let guidance: PromptGuidance | undefined;
  let prompt: string;
  switch (call) {
    case 'generation':
      guidance = guidanceFor('generation', config?.guidance, undefined);
      prompt = generationPrompt.build({ endpoints: flow.endpoints }, guidance);
      break;
    case 'selectFields':
      guidance = narrow([endpoint]);
      prompt = selectFieldsPrompt.build({ endpoint, baseFields: endpoint.fields, previouslyCollectedData: {} }, guidance);
      break;
    case 'validate':
      guidance = narrow([endpoint]);
      prompt = validatePrompt.build({ endpoint, data, previouslyCollectedData: {} }, guidance);
      break;
    case 'invalidation': {
      const later = flow.endpoints.slice(index + 1);
      guidance = narrow([endpoint, ...later]);
      prompt = invalidationPrompt.build(
        { editedEndpoint: endpoint, before: {}, after: {}, laterCompletedEndpoints: later },
        guidance
      );
      break;
    }
    case 'classifyFailure':
      guidance = narrow([endpoint]);
      prompt = classifyFailurePrompt.build(
        {
          failedEndpoint: endpoint,
          failure: { kind: 'http', status: 400, message: '(the API error message goes here)' },
          completedEndpoints: flow.endpoints.slice(0, index),
        },
        guidance
      );
      break;
  }
  const block = renderGuidance(guidance);
  const start = block ? prompt.indexOf(block) : -1;
  return { prompt, guidanceRange: start === -1 ? null : { start, end: start + block.length } };
}

// ---------------------------------------------------------------------------
// Eval jobs
// ---------------------------------------------------------------------------

interface EvalJob {
  id: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  done: number;
  total: number;
  report?: EvalReport;
  error?: string;
  controller: AbortController;
}

const KEPT_JOBS = 5;

const EvalRequestSchema = z
  .object({
    calls: z.array(z.enum(EVAL_CALLS)).min(1).optional(),
    repeat: z.number().int().min(1).max(10).optional(),
    flow: GeneratedFlowSchema.optional(),
  })
  .strict();

const PlanQuerySchema = z.object({
  calls: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',') : undefined))
    .pipe(z.array(z.enum(EVAL_CALLS)).min(1).optional()),
  repeat: z.coerce.number().int().min(1).max(10).optional(),
});

// Everything that would make a run fail at once is reported as a 400 instead.
function checkCanRun(): { provider: string; model: string } {
  if (isStaticMode()) throw new RangeError('AGENTINTAKE_STATIC_MODE is on: the evals would only measure fallbacks.');
  const provider = resolveProvider();
  buildModel(provider);
  return { provider, model: resolveModelId(provider) };
}

export interface StudioGuidanceRoutesOptions {
  configStore: StudioConfigStore;
  /** Where the built-in eval cases are; defaults to the package's evals/cases. */
  casesDir?: string;
}

export function registerStudioGuidanceRoutes(app: Express, { configStore, casesDir }: StudioGuidanceRoutesOptions): void {
  app.get('/api/studio/config', (_req, res) => {
    res.status(200).json({ guidance: configStore.get()?.guidance ?? {}, path: configStore.path, limits: GUIDANCE_LIMITS });
  });

  app.post('/api/studio/config', express.json({ limit: '1mb' }), async (req, res) => {
    const body = req.body as { guidance?: unknown } | undefined;
    if (!body || typeof body !== 'object' || Object.keys(body).some((key) => key !== 'guidance')) {
      res.status(400).json({ error: 'Request body must be { guidance }.', issues: [] });
      return;
    }
    const existing = configStore.get();
    // The file is always the resolved config path, never one from the
    // request; an editor's $schema hint already in it is kept.
    const candidate = {
      ...(existing?.$schema ? { $schema: existing.$schema } : {}),
      ...(withoutEmpty({ guidance: body.guidance }) as object | undefined),
    };
    const parsed = AgentIntakeConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      res.status(400).json({ error: 'The guidance is invalid.', issues: issuesOf(parsed.error) });
      return;
    }
    try {
      await writeFileAtomic(configStore.path, JSON.stringify(parsed.data, null, 2) + '\n');
    } catch (error) {
      res.status(500).json({ error: `Couldn't write ${configStore.path}: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    configStore.set(parsed.data);
    res.status(200).json({ config: parsed.data, path: configStore.path });
  });

  app.post('/api/studio/render-prompt', express.json({ limit: '10mb' }), (req, res) => {
    const parsed = RenderPromptSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Request body must be { call, flow, endpointId?, data? }.', issues: issuesOf(parsed.error) });
      return;
    }
    const { call, flow, endpointId, data } = parsed.data;
    try {
      res.status(200).json(renderPrompt(call, flow, endpointId, data ?? {}, configStore.get()));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error), issues: [] });
    }
  });

  const jobs = new Map<string, EvalJob>();
  const cases = () => loadCases(casesDir ?? builtinCasesDir());

  // The step ids the built-in cases use: step guidance only reaches a case
  // whose step has the same id, so the UI can say what a test covers.
  app.get('/api/studio/evals/cases', (_req, res) => {
    try {
      const ids = new Set<string>();
      for (const c of cases()) {
        const input = c.input as Record<string, any>;
        const endpoints = [
          ...(input.endpoints ?? []),
          input.endpoint,
          input.editedEndpoint,
          ...(input.laterCompletedEndpoints ?? []),
          input.failedEndpoint,
          ...(input.completedEndpoints ?? []),
        ].filter(Boolean);
        for (const endpoint of endpoints) ids.add(endpoint.id);
      }
      res.status(200).json({ stepIds: [...ids].sort() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/studio/evals/plan', (req, res) => {
    const query = PlanQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: 'Query must be calls=<comma-separated calls>&repeat=<1-10>.', issues: issuesOf(query.error) });
      return;
    }
    try {
      const { provider, model } = checkCanRun();
      res.status(200).json({ runs: countRuns({ cases: cases(), ...query.data }), provider, model });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error), issues: [] });
    }
  });

  app.post('/api/studio/evals', express.json({ limit: '10mb' }), (req, res) => {
    const parsed = EvalRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Request body must be { calls?, repeat?, flow? }.', issues: issuesOf(parsed.error) });
      return;
    }
    if ([...jobs.values()].some((job) => job.status === 'running')) {
      res.status(409).json({ error: 'An eval run is already going; wait for it or cancel it.' });
      return;
    }
    let total: number;
    let loaded: ReturnType<typeof cases>;
    try {
      checkCanRun();
      loaded = cases();
      total = countRuns({ cases: loaded, calls: parsed.data.calls, repeat: parsed.data.repeat });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error), issues: [] });
      return;
    }

    const job: EvalJob = { id: randomUUID(), status: 'running', done: 0, total, controller: new AbortController() };
    jobs.set(job.id, job);
    for (const id of [...jobs.keys()].slice(0, Math.max(0, jobs.size - KEPT_JOBS))) jobs.delete(id);

    runEvals({
      cases: loaded,
      config: configStore.get(),
      flow: parsed.data.flow ?? null,
      calls: parsed.data.calls,
      repeat: parsed.data.repeat,
      signal: job.controller.signal,
      onRun: () => {
        job.done++;
      },
    })
      .then((report) => {
        job.report = report;
        job.status = job.controller.signal.aborted ? 'cancelled' : 'done';
      })
      .catch((error: unknown) => {
        job.error = error instanceof Error ? error.message : String(error);
        job.status = 'failed';
      });

    res.status(202).json({ jobId: job.id, runs: total });
  });

  const view = ({ controller: _controller, id: _id, ...job }: EvalJob) => job;

  app.get('/api/studio/evals/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'No such eval run.' });
      return;
    }
    res.status(200).json(view(job));
  });

  app.delete('/api/studio/evals/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'No such eval run.' });
      return;
    }
    // No new run starts; those in flight finish, then the job is "cancelled".
    if (job.status === 'running') job.controller.abort();
    res.status(200).json(view(job));
  });
}
