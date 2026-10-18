import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readPackageVersion } from './version.js';

const created: string[] = [];
afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function packageAt(layout: Record<string, object>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-intake-version-'));
  created.push(root);
  for (const [relative, manifest] of Object.entries(layout)) {
    mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
    writeFileSync(path.join(root, relative), JSON.stringify(manifest));
  }
  return root;
}

describe('readPackageVersion', () => {
  it("is the repository's own package.json version, not a copy of it", () => {
    const manifest = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf-8')) as { version: string };
    expect(readPackageVersion()).toBe(manifest.version);
  });

  it('finds the package from the source tree and from the deeper compiled tree', () => {
    const root = packageAt({ 'package.json': { name: 'agent-intake', version: '9.8.7' } });
    for (const file of ['cli/index.ts', 'dist/cli/index.js']) {
      mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
      expect(readPackageVersion(pathToFileURL(path.join(root, file)).href)).toBe('9.8.7');
    }
  });

  it('skips a package.json of another package on the way up', () => {
    const root = packageAt({
      'package.json': { name: 'agent-intake', version: '1.2.3' },
      'node_modules/other/package.json': { name: 'other', version: '0.0.1' },
    });
    expect(readPackageVersion(pathToFileURL(path.join(root, 'node_modules/other/index.js')).href)).toBe('1.2.3');
  });

  it('fails clearly when no agent-intake package.json exists above the file', () => {
    const root = packageAt({ 'package.json': { name: 'something-else', version: '1.0.0' } });
    expect(() => readPackageVersion(pathToFileURL(path.join(root, 'index.js')).href)).toThrow(
      /Could not find the agent-intake package\.json/
    );
  });
});
