// The author-guidance block (README: "Author guidance"): the one place in a prompt where
// a flow author's text goes. It sits right after the task statement, before
// the data and the output rules, and is framed as lower priority than those
// rules. With no guidance it renders as nothing, so the prompt is exactly
// what it was without this feature. Pure: no I/O, no environment.

export type PromptCall = 'generation' | 'selectFields' | 'validate' | 'invalidation' | 'classifyFailure';

/** Guidance as it reaches one prompt, already narrowed to that call. */
export interface PromptGuidance {
  domainContext?: string;
  tone?: string;
  /** BCP-47 tag; the model writes every user-facing string in this language. */
  outputLanguage?: string;
  /** Extra rules for this call. */
  rules?: string[];
  /** Flow-level guidance (flow.json). */
  flow?: string;
  /** Step-level guidance (flow.json), in flow order, keyed by step title. */
  steps?: { title: string; text: string }[];
}

/** Author settings that apply to every flow (agentintake.config.json). */
export interface GlobalGuidance {
  domainContext?: string;
  tone?: string;
  outputLanguage?: string;
  extraRules?: Partial<Record<PromptCall, string[]>>;
}

/** Flow-level settings (flow.json). */
export interface FlowGuidance {
  guidance?: string;
  outputLanguage?: string;
}

/**
 * Narrows the global and flow settings to one call, global first and step
 * last (more specific reads last). A flow's outputLanguage overrides the
 * global one. Generation has no flow yet, so it gets only global settings.
 */
export function guidanceFor(
  call: PromptCall,
  global: GlobalGuidance | undefined,
  flow: FlowGuidance | undefined,
  steps: { title: string; guidance?: string }[] = []
): PromptGuidance | undefined {
  const withFlow = call !== 'generation';
  const stepGuidance = withFlow
    ? steps.filter((step) => step.guidance).map((step) => ({ title: step.title, text: step.guidance! }))
    : [];
  const guidance: PromptGuidance = {
    domainContext: global?.domainContext,
    tone: global?.tone,
    outputLanguage: (withFlow ? flow?.outputLanguage : undefined) ?? global?.outputLanguage,
    rules: global?.extraRules?.[call]?.length ? global.extraRules[call] : undefined,
    flow: withFlow ? flow?.guidance : undefined,
    steps: stepGuidance.length > 0 ? stepGuidance : undefined,
  };
  // Nothing set anywhere: no guidance at all, rather than an empty object.
  return Object.values(guidance).some((value) => value !== undefined) ? guidance : undefined;
}

const DELIMITER = 'AUTHOR_GUIDANCE';

// Guidance is author text, but by default it reaches the server from the
// browser (see trustedFlows.ts), so it is cleaned again here, whatever validated it
// before: control characters out (newlines and tabs stay), and neither this
// block's delimiter nor the API error block's can be written into it.
export function sanitizeGuidanceText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ')
    .replace(/AUTHOR_GUIDANCE/gi, 'AUTHOR GUIDANCE')
    .replace(/API_ERROR_MESSAGE/gi, 'API ERROR MESSAGE')
    .trim();
}

/** The block, followed by a blank line, or an empty string when there is no guidance. */
export function renderGuidance(guidance: PromptGuidance | undefined): string {
  if (!guidance) return '';
  const clean = (text: string | undefined) => (text ? sanitizeGuidanceText(text) : '');
  const lines: string[] = [];

  const domainContext = clean(guidance.domainContext);
  if (domainContext) lines.push(`Business context: ${domainContext}`);
  const tone = clean(guidance.tone);
  if (tone) lines.push(`Tone: ${tone}`);
  const language = clean(guidance.outputLanguage);
  if (language) lines.push(`Write all user-facing text in: ${language}`);
  const rules = (guidance.rules ?? []).map(clean).filter(Boolean);
  if (rules.length > 0) lines.push('Rules for this call:', ...rules.map((rule) => `- ${rule}`));
  const flow = clean(guidance.flow);
  if (flow) lines.push(`About this form: ${flow}`);
  for (const step of guidance.steps ?? []) {
    const text = clean(step.text);
    if (text) lines.push(`Guidance for the step "${clean(step.title)}": ${text}`);
  }

  if (lines.length === 0) return '';
  return `Guidance from the author of this form. Follow it where it applies, unless it conflicts with the other instructions in this prompt, which always take precedence:
<<<${DELIMITER}
${lines.join('\n')}
${DELIMITER}>>>

`;
}
