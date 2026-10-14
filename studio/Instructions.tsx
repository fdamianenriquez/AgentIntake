import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  GUIDANCE_LIMITS,
  LanguageTagSchema,
  type GeneratedFlow,
} from '../packages/react-agent-intake/src/contracts.js';

// The Instructions tab: guidance an author adds to what the
// model is told -- global (saved to agentintake.config.json through Studio's
// local-only routes), and per flow and step (kept in the flow, so it goes out
// with flow.json). There is no free-text prompt editor: the view of what the
// model receives shows the fixed parts read-only.

export const CALLS = ['generation', 'selectFields', 'validate', 'invalidation', 'classifyFailure'] as const;
export type Call = (typeof CALLS)[number];

export const CALL_LABELS: Record<Call, string> = {
  generation: 'Flow generation',
  selectFields: 'Choosing fields per step',
  validate: 'Checking answers',
  invalidation: 'Checking later steps after an edit',
  classifyFailure: 'Explaining a failed step',
};

export interface GlobalGuidance {
  domainContext?: string;
  tone?: string;
  outputLanguage?: string;
  extraRules?: Partial<Record<Call, string[]>>;
}

type Limits = typeof GUIDANCE_LIMITS;
type Issue = { path: string; message: string };

const languageProblem = (value: string) =>
  value.trim() === '' || LanguageTagSchema.safeParse(value.trim()).success ? null : 'Use a BCP-47 language tag, e.g. "es-MX" or "ja".';

// ---------------------------------------------------------------------------
// A text control with a character counter and its limit
// ---------------------------------------------------------------------------

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  limit?: number;
  multiline?: boolean;
  hint?: string;
  /** A problem found elsewhere (the server, a format check). */
  error?: string | null;
}

function TextField({ label, value, onChange, limit, multiline, hint, error }: TextFieldProps) {
  const id = useId();
  const over = limit !== undefined && value.length > limit;
  const problem = over ? `Too long: at most ${limit} characters.` : error;
  const describedBy = [limit !== undefined ? `${id}-count` : null, hint ? `${id}-hint` : null, problem ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');
  const props = {
    id,
    value,
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    'aria-invalid': problem ? true : undefined,
    'aria-describedby': describedBy || undefined,
  };
  return (
    <div className="studio-field">
      <label htmlFor={id}>{label}</label>
      {hint && (
        <p id={`${id}-hint`} className="studio-field-hint">
          {hint}
        </p>
      )}
      {multiline ? <textarea rows={3} {...props} /> : <input type="text" {...props} />}
      {limit !== undefined && (
        <p id={`${id}-count`} className={over ? 'studio-counter studio-error' : 'studio-counter'}>
          {value.length} / {limit}
        </p>
      )}
      {problem && (
        <p id={`${id}-error`} role="alert" className="studio-error">
          {problem}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// a) Global guidance
// ---------------------------------------------------------------------------

function GlobalGuidanceForm({ onSaved }: { onSaved: (guidance: GlobalGuidance) => void }) {
  const [draft, setDraft] = useState<GlobalGuidance | null>(null);
  const [limits, setLimits] = useState<Limits>(GUIDANCE_LIMITS);
  const [path, setPath] = useState('');
  const [issues, setIssues] = useState<Issue[]>([]);
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/studio/config')
      .then((response) => response.json())
      .then((body: { guidance: GlobalGuidance; path: string; limits: Limits }) => {
        setDraft(body.guidance);
        setLimits(body.limits);
        setPath(body.path);
        onSaved(body.guidance);
      })
      .catch(() => setStatus({ kind: 'error', text: "Couldn't load the saved guidance." }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!draft) return <p role="status">Loading the global guidance…</p>;

  const update = (patch: Partial<GlobalGuidance>) => {
    setDraft({ ...draft, ...patch });
    setStatus(null);
  };
  const rules = (call: Call) => draft.extraRules?.[call] ?? [];
  const setRules = (call: Call, list: string[]) => update({ extraRules: { ...draft.extraRules, [call]: list } });
  const issueAt = (path: string) => issues.find((issue) => issue.path === path)?.message ?? null;

  const clientProblems =
    (draft.domainContext ?? '').length > limits.domainContext ||
    (draft.tone ?? '').length > limits.tone ||
    languageProblem(draft.outputLanguage ?? '') !== null ||
    CALLS.some((call) => rules(call).length > limits.extraRules || rules(call).some((rule) => rule.length > limits.extraRule));

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const response = await fetch('/api/studio/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guidance: draft }),
      });
      const body = await response.json();
      if (!response.ok) {
        setIssues(body.issues ?? []);
        setStatus({ kind: 'error', text: body.error ?? 'The guidance could not be saved.' });
        return;
      }
      setIssues([]);
      const saved: GlobalGuidance = body.config.guidance ?? {};
      setDraft(saved);
      onSaved(saved);
      setStatus({ kind: 'saved', text: `Saved to ${body.path}.` });
    } catch {
      setStatus({ kind: 'error', text: "Couldn't reach Studio's server." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="studio-instructions-section" aria-labelledby="global-guidance-title">
      <h3 id="global-guidance-title">Global guidance</h3>
      <p className="studio-field-hint">
        Applies to every flow. Saved to <code>{path}</code>; the preview and tests use it once saved.
      </p>
      <TextField
        label="Business context"
        hint='What the business or process is, e.g. "B2B payment onboarding for marketplaces".'
        value={draft.domainContext ?? ''}
        onChange={(domainContext) => update({ domainContext })}
        limit={limits.domainContext}
        multiline
        error={issueAt('guidance.domainContext')}
      />
      <TextField
        label="Tone"
        hint='Voice of the text the model writes, e.g. "formal, second person".'
        value={draft.tone ?? ''}
        onChange={(tone) => update({ tone })}
        limit={limits.tone}
        error={issueAt('guidance.tone')}
      />
      <TextField
        label="Output language"
        hint="Language of every text the model writes. The form's own buttons and messages stay as they are."
        value={draft.outputLanguage ?? ''}
        onChange={(outputLanguage) => update({ outputLanguage })}
        error={languageProblem(draft.outputLanguage ?? '') ?? issueAt('guidance.outputLanguage')}
      />
      <fieldset className="studio-rules">
        <legend>Extra rules per call</legend>
        {CALLS.map((call) => (
          <div key={call} className="studio-rule-list">
            <h4>{CALL_LABELS[call]}</h4>
            {rules(call).map((rule, index) => (
              <div key={index} className="studio-rule">
                <TextField
                  label={`${CALL_LABELS[call]}: rule ${index + 1}`}
                  value={rule}
                  onChange={(text) => setRules(call, rules(call).map((r, i) => (i === index ? text : r)))}
                  limit={limits.extraRule}
                  error={issueAt(`guidance.extraRules.${call}.${index}`)}
                />
                <button type="button" onClick={() => setRules(call, rules(call).filter((_, i) => i !== index))}>
                  Remove rule {index + 1} ({CALL_LABELS[call]})
                </button>
              </div>
            ))}
            <button
              type="button"
              disabled={rules(call).length >= limits.extraRules}
              onClick={() => setRules(call, [...rules(call), ''])}
            >
              Add a rule ({CALL_LABELS[call]})
            </button>
            {rules(call).length >= limits.extraRules && (
              <p className="studio-field-hint">At most {limits.extraRules} rules per call.</p>
            )}
          </div>
        ))}
      </fieldset>
      <button type="button" onClick={() => void save()} disabled={saving || clientProblems}>
        {saving ? 'Saving…' : 'Save global guidance'}
      </button>
      {status && (
        <p role={status.kind === 'error' ? 'alert' : 'status'} className={status.kind === 'error' ? 'studio-error' : 'studio-success'}>
          {status.text}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// b) Flow and step guidance
// ---------------------------------------------------------------------------

/** Problems that make the flow's guidance invalid (the same limits flow.json has). */
export function flowGuidanceProblems(flow: GeneratedFlow): string[] {
  const problems: string[] = [];
  if ((flow.guidance ?? '').length > GUIDANCE_LIMITS.flowGuidance) problems.push('The flow guidance is too long.');
  if (languageProblem(flow.outputLanguage ?? '')) problems.push("The flow's output language is not a BCP-47 tag.");
  for (const endpoint of flow.endpoints) {
    if ((endpoint.guidance ?? '').length > GUIDANCE_LIMITS.endpointGuidance) problems.push(`The guidance for "${endpoint.title}" is too long.`);
  }
  return problems;
}

/** The flow with empty guidance fields removed, as it goes to the server and into flow.json. */
export function cleanFlow(flow: GeneratedFlow): GeneratedFlow {
  const { guidance, outputLanguage, endpoints, ...rest } = flow;
  return {
    ...rest,
    ...(guidance?.trim() ? { guidance } : {}),
    ...(outputLanguage?.trim() ? { outputLanguage: outputLanguage.trim() } : {}),
    endpoints: endpoints.map(({ guidance: step, ...endpoint }) => (step?.trim() ? { ...endpoint, guidance: step } : endpoint)),
  };
}

function FlowGuidanceForm({ flow, onFlowChange }: { flow: GeneratedFlow; onFlowChange: (flow: GeneratedFlow) => void }) {
  return (
    <section className="studio-instructions-section" aria-labelledby="flow-guidance-title">
      <h3 id="flow-guidance-title">Flow and step guidance</h3>
      <p className="studio-field-hint">Part of this flow: the preview uses it at once, and the downloaded flow.json includes it.</p>
      <TextField
        label="Flow guidance"
        value={flow.guidance ?? ''}
        onChange={(guidance) => onFlowChange({ ...flow, guidance })}
        limit={GUIDANCE_LIMITS.flowGuidance}
        multiline
      />
      <TextField
        label="Flow output language"
        hint="Overrides the global output language for this flow."
        value={flow.outputLanguage ?? ''}
        onChange={(outputLanguage) => onFlowChange({ ...flow, outputLanguage })}
        error={languageProblem(flow.outputLanguage ?? '')}
      />
      {flow.endpoints.map((endpoint, index) => (
        <TextField
          key={endpoint.id}
          label={`Guidance for the step "${endpoint.title}"`}
          value={endpoint.guidance ?? ''}
          onChange={(guidance) =>
            onFlowChange({ ...flow, endpoints: flow.endpoints.map((e, i) => (i === index ? { ...e, guidance } : e)) })
          }
          limit={GUIDANCE_LIMITS.endpointGuidance}
          multiline
        />
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// c) What the model receives
// ---------------------------------------------------------------------------

function PromptView({ flow, configVersion, debounceMs }: { flow: GeneratedFlow; configVersion: number; debounceMs: number }) {
  const [call, setCall] = useState<Call>('validate');
  const [endpointId, setEndpointId] = useState(flow.endpoints[0]?.id ?? '');
  const [rendered, setRendered] = useState<{ prompt: string; guidanceRange: { start: number; end: number } | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const callId = useId();
  const stepId = useId();

  const sent = useMemo(() => cleanFlow(flow), [flow]);
  useEffect(() => {
    if (flowGuidanceProblems(flow).length > 0) {
      setError('Fix the guidance above to see the prompt.');
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch('/api/studio/render-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ call, flow: sent, endpointId }),
        signal: controller.signal,
      })
        .then(async (response) => {
          const body = await response.json();
          if (!response.ok) throw new Error(body.error ?? 'The prompt could not be rendered.');
          setRendered(body);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
        });
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [call, endpointId, sent, configVersion, debounceMs, flow]);

  const range = rendered?.guidanceRange;
  return (
    <section className="studio-instructions-section" aria-labelledby="prompt-view-title">
      <h3 id="prompt-view-title">What the model receives</h3>
      <div className="studio-prompt-controls">
        <label htmlFor={callId}>Call</label>
        <select id={callId} value={call} onChange={(event) => setCall(event.target.value as Call)}>
          {CALLS.map((c) => (
            <option key={c} value={c}>
              {CALL_LABELS[c]}
            </option>
          ))}
        </select>
        <label htmlFor={stepId}>Step</label>
        <select id={stepId} value={endpointId} onChange={(event) => setEndpointId(event.target.value)} disabled={call === 'generation'}>
          {flow.endpoints.map((endpoint) => (
            <option key={endpoint.id} value={endpoint.id}>
              {endpoint.title}
            </option>
          ))}
        </select>
      </div>
      <p className="studio-field-hint">
        <span className="studio-legend-locked">Grey text</span> is written by AgentIntake and can't be changed.{' '}
        <mark>Highlighted text</mark> is your guidance. Example values stand in for real answers.
      </p>
      {error && (
        <p role="alert" className="studio-error">
          {error}
        </p>
      )}
      {rendered && (
        <pre className="studio-prompt" aria-label="Rendered prompt">
          {range ? (
            <>
              <span className="studio-locked" data-locked="true">
                {rendered.prompt.slice(0, range.start)}
              </span>
              <mark className="studio-guidance" data-guidance="true">
                {rendered.prompt.slice(range.start, range.end)}
              </mark>
              <span className="studio-locked" data-locked="true">
                {rendered.prompt.slice(range.end)}
              </span>
            </>
          ) : (
            <span className="studio-locked" data-locked="true">
              {rendered.prompt}
            </span>
          )}
        </pre>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Test: the built-in eval cases, with this guidance
// ---------------------------------------------------------------------------

interface CallSummary {
  runs: number;
  passed: number;
  degraded: number;
  passRate: number;
  p50Ms: number;
  p95Ms: number;
  failures: { name: string; run: number; reason?: string; degradedReason?: string; got?: unknown }[];
}
interface EvalJobView {
  status: 'running' | 'done' | 'failed' | 'cancelled';
  done: number;
  total: number;
  report?: { calls: Partial<Record<Call, CallSummary>> };
  error?: string;
}

/** What each call's prompt gets from guidance; a call whose signature changed needs testing again. */
export function guidanceSignatures(global: GlobalGuidance, flow: GeneratedFlow): Record<Call, string> {
  const shared = { domainContext: global.domainContext, tone: global.tone, outputLanguage: global.outputLanguage };
  const flowPart = { guidance: flow.guidance, outputLanguage: flow.outputLanguage, steps: flow.endpoints.map((e) => [e.id, e.guidance]) };
  return Object.fromEntries(
    CALLS.map((call) => [
      call,
      JSON.stringify({ shared, rules: global.extraRules?.[call] ?? [], flow: call === 'generation' ? null : flowPart }),
    ])
  ) as Record<Call, string>;
}

const percent = (rate: number) => `${Math.round(rate * 100)}%`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function TestPanel({ flow, savedGlobal, pollMs }: { flow: GeneratedFlow; savedGlobal: GlobalGuidance; pollMs: number }) {
  const signatures = guidanceSignatures(savedGlobal, flow);
  const [lastTested, setLastTested] = useState<Partial<Record<Call, string>>>({});
  const changed = CALLS.filter((call) => lastTested[call] !== signatures[call]);
  const [picked, setPicked] = useState<Call[] | null>(null); // null: follow "changed"
  const selected = picked ?? (changed.length > 0 ? changed : [...CALLS]);
  const [plan, setPlan] = useState<{ runs: number; provider: string; model: string } | null>(null);
  const [job, setJob] = useState<{ id: string; view: EvalJobView } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const testedSignatures = useRef<Partial<Record<Call, string>>>({});
  const running = job?.view.status === 'running';

  useEffect(() => {
    if (!job || job.view.status !== 'running') return;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/studio/evals/${job.id}`);
        const view: EvalJobView = await response.json();
        setJob({ id: job.id, view });
        if (view.status === 'done' || view.status === 'cancelled') {
          setLastTested((previous) => ({ ...previous, ...testedSignatures.current }));
        }
      } catch {
        setError("Couldn't reach Studio's server.");
      }
    }, pollMs);
    return () => clearInterval(timer);
  }, [job, pollMs]);

  const askToRun = async () => {
    setError(null);
    const response = await fetch(`/api/studio/evals/plan?calls=${selected.join(',')}`);
    const body = await response.json();
    if (!response.ok) return setError(body.error ?? "The test can't run.");
    setPlan(body);
  };

  const run = async () => {
    setPlan(null);
    testedSignatures.current = Object.fromEntries(selected.map((call) => [call, signatures[call]]));
    const response = await fetch('/api/studio/evals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calls: selected, flow: cleanFlow(flow) }),
    });
    const body = await response.json();
    if (!response.ok) return setError(body.error ?? "The test couldn't start.");
    setJob({ id: body.jobId, view: { status: 'running', done: 0, total: body.runs } });
  };

  const cancel = async () => {
    if (job) await fetch(`/api/studio/evals/${job.id}`, { method: 'DELETE' });
  };

  const toggle = (call: Call) =>
    setPicked(selected.includes(call) ? selected.filter((c) => c !== call) : [...selected, call]);
  const report = job?.view.report;

  return (
    <section className="studio-instructions-section" aria-labelledby="test-title">
      <h3 id="test-title">Test</h3>
      <p className="studio-field-hint">
        Runs AgentIntake's built-in cases with the saved global guidance and this flow's guidance, against your configured
        model. It spends model calls. Calls whose guidance changed since the last test are selected.
      </p>
      <fieldset disabled={running}>
        <legend>Calls to test</legend>
        {CALLS.map((call) => (
          <label key={call} className="studio-checkbox">
            <input type="checkbox" checked={selected.includes(call)} onChange={() => toggle(call)} />
            {CALL_LABELS[call]}
            {changed.includes(call) && Object.keys(lastTested).length > 0 ? ' (changed)' : ''}
          </label>
        ))}
        <button type="button" onClick={() => setPicked([...CALLS])}>
          Select all
        </button>
      </fieldset>
      <button type="button" onClick={() => void askToRun()} disabled={running || selected.length === 0 || plan !== null}>
        Test
      </button>

      {plan && (
        <div role="dialog" aria-labelledby="test-confirm" className="studio-confirm">
          <p id="test-confirm">
            This will make {plan.runs} run(s) -- at least {plan.runs} model call(s) -- with {plan.provider} / {plan.model}.
          </p>
          <button type="button" onClick={() => void run()}>
            Run {plan.runs} test run(s)
          </button>
          <button type="button" onClick={() => setPlan(null)}>
            Don't run
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="studio-error">
          {error}
        </p>
      )}

      {job && running && (
        <div>
          <p role="status">
            Running: {job.view.done} / {job.view.total}
          </p>
          <button type="button" onClick={() => void cancel()}>
            Cancel the test
          </button>
        </div>
      )}
      {job?.view.status === 'failed' && (
        <p role="alert" className="studio-error">
          The test failed: {job.view.error}
        </p>
      )}
      {job?.view.status === 'cancelled' && <p role="status">Cancelled after {job.view.done} of {job.view.total} runs.</p>}

      {report && (
        <>
          <table className="studio-report">
            <caption>Results</caption>
            <thead>
              <tr>
                <th scope="col">Call</th>
                <th scope="col">Runs</th>
                <th scope="col">Passed</th>
                <th scope="col">Rate</th>
                <th scope="col">Degraded</th>
                <th scope="col">p50</th>
                <th scope="col">p95</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(report.calls).map(([call, summary]) => (
                <tr key={call}>
                  <th scope="row">{CALL_LABELS[call as Call]}</th>
                  <td>{summary!.runs}</td>
                  <td>{summary!.passed}</td>
                  <td>{percent(summary!.passRate)}</td>
                  <td>{summary!.degraded}</td>
                  <td>{seconds(summary!.p50Ms)}</td>
                  <td>{seconds(summary!.p95Ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {Object.entries(report.calls).some(([, summary]) => summary!.failures.length > 0) && (
            <div>
              <h4>Failing runs</h4>
              <ul className="studio-failures">
                {Object.entries(report.calls).flatMap(([call, summary]) =>
                  summary!.failures.map((failure) => (
                    <li key={`${call}-${failure.name}-${failure.run}`}>
                      <strong>
                        {CALL_LABELS[call as Call]}: {failure.name}
                      </strong>{' '}
                      (run {failure.run}): {failure.degradedReason ? `fell back: ${failure.degradedReason}` : failure.reason}
                      {failure.got !== undefined && <pre>{JSON.stringify(failure.got, null, 2)}</pre>}
                    </li>
                  ))
                )}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

export interface InstructionsProps {
  flow: GeneratedFlow;
  onFlowChange: (flow: GeneratedFlow) => void;
  /** For tests: debounce of the prompt view, and the eval polling interval. */
  timings?: { debounceMs?: number; pollMs?: number };
}

export function Instructions({ flow, onFlowChange, timings }: InstructionsProps) {
  const [savedGlobal, setSavedGlobal] = useState<GlobalGuidance>({});
  const [configVersion, setConfigVersion] = useState(0);
  return (
    <div className="studio-instructions">
      <GlobalGuidanceForm
        onSaved={(guidance) => {
          setSavedGlobal(guidance);
          setConfigVersion((version) => version + 1);
        }}
      />
      <FlowGuidanceForm flow={flow} onFlowChange={onFlowChange} />
      <PromptView flow={flow} configVersion={configVersion} debounceMs={timings?.debounceMs ?? 400} />
      <TestPanel flow={flow} savedGlobal={savedGlobal} pollMs={timings?.pollMs ?? 1000} />
    </div>
  );
}
