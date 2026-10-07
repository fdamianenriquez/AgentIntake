import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// llmClient.ts is the only module allowed to import provider SDKs, and browser
// code must never reach it -- not for secrecy (keys are only read server-side)
// but because it would ship the SDKs to every browser and blur the rule that
// all LLM access is server-side. This walks static imports to enforce that.

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const llmClientPath = path.join(repoRoot, 'server/src/llmClient.ts');
const FORBIDDEN_PACKAGE = /^(ai|@ai-sdk\/.+)$/;

const IMPORT_RE =
  /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function runtimeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const isTypeOnly = Boolean(match[2]);
    const specifier = match[3] ?? match[4];
    if (specifier && !isTypeOnly) specifiers.push(specifier);
  }
  return specifiers;
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, `${base}.tsx`];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

/** Returns the import chains that lead from `entry` to llmClient.ts or a provider SDK. */
export function findForbiddenImports(entry: string): string[] {
  const violations: string[] = [];
  const seen = new Set<string>();

  const visit = (file: string, chain: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (file === llmClientPath) {
      violations.push([...chain, 'server/src/llmClient.ts'].join(' -> '));
      return;
    }
    if (!/\.(ts|tsx)$/.test(file)) return;

    for (const specifier of runtimeSpecifiers(readFileSync(file, 'utf-8'))) {
      const here = [...chain, path.relative(repoRoot, file)];
      if (FORBIDDEN_PACKAGE.test(specifier)) {
        violations.push([...here, specifier].join(' -> '));
      } else if (specifier.startsWith('.')) {
        const resolved = resolveRelative(file, specifier);
        if (resolved) visit(resolved, here);
      }
    }
  };

  visit(entry, []);
  return violations;
}

function browserSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== 'node_modules') walk(full);
      } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'vite.config.ts') {
        files.push(full);
      }
    }
  };
  for (const dir of ['studio', 'demo', 'packages']) walk(path.join(repoRoot, dir));
  return files;
}

describe('browser code never reaches llmClient.ts or a provider SDK', () => {
  const entries = browserSourceFiles();

  it('finds the browser source files to check', () => {
    expect(entries.length).toBeGreaterThan(5);
  });

  it.each(entries.map((file) => [path.relative(repoRoot, file), file]))('%s', (_label, file) => {
    expect(findForbiddenImports(file)).toEqual([]);
  });

  it('control: the detector does flag a module that imports llmClient', () => {
    const flowGenerator = path.join(repoRoot, 'server/src/flowGenerator.ts');
    expect(findForbiddenImports(flowGenerator)).toContain(
      'server/src/flowGenerator.ts -> server/src/llmClient.ts'
    );
  });

  it('control: type-only imports are ignored, since they are erased at build time', () => {
    expect(runtimeSpecifiers("import type { Foo } from './llmClient.js';")).toEqual([]);
    expect(runtimeSpecifiers("import { type Foo, bar } from './llmClient.js';")).toEqual(['./llmClient.js']);
  });
});
