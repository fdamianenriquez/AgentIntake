import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { GeneratedFlowSchema, type GeneratedFlow } from '../../packages/react-agent-intake/src/contracts.js';

// Trusted flows (README: "Trust model and trusted flows"). By default the browser sends the flow's
// guidance with every call, so an end user can change it -- acceptable,
// since what it steers (adaptive fields, semantic validation) is UX, not
// security. A deployer who wants guidance to be authoritative points
// AGENTINTAKE_FLOWS_DIR at the flow.json files: the server loads them at
// startup and, for a flow it knows, uses its own guidance and ignores the
// client's. Field definitions still come from the client.

/**
 * Loads every *.json in AGENTINTAKE_FLOWS_DIR (relative to `cwd`), keyed by
 * flow id. Unset: null (trusted flows off). A missing directory, an invalid
 * file or two files with the same flow id is an error naming the file.
 */
export function loadTrustedFlows(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): Map<string, GeneratedFlow> | null {
  const setting = env.AGENTINTAKE_FLOWS_DIR?.trim();
  if (!setting) return null;
  const dir = path.resolve(cwd, setting);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`AGENTINTAKE_FLOWS_DIR: ${dir} is not a directory.`);
  }

  const flows = new Map<string, GeneratedFlow>();
  const sources = new Map<string, string>();
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
    const file = path.join(dir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf-8'));
    } catch (error) {
      throw new Error(`${file}: not valid JSON (${error instanceof Error ? error.message : String(error)}).`);
    }
    const parsed = GeneratedFlowSchema.safeParse(raw);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((issue) => `  ${issue.path.join('.') || '(top level)'}: ${issue.message}`);
      throw new Error(`${file} is not a valid flow:\n${problems.join('\n')}`);
    }
    const previous = sources.get(parsed.data.id);
    if (previous) throw new Error(`${file}: flow id "${parsed.data.id}" is also used by ${previous}.`);
    flows.set(parsed.data.id, parsed.data);
    sources.set(parsed.data.id, file);
  }
  return flows;
}
