import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The version of the installed package, read from the nearest package.json
 * above this file. It is found by walking up rather than by a fixed number of
 * `../` because compiled output (`dist/cli/`) sits one level deeper than the
 * source tree.
 */
export function readPackageVersion(from: string = import.meta.url): string {
  let directory = path.dirname(fileURLToPath(from));
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf-8')) as { name?: string; version?: string };
      if (manifest.name === 'agent-intake' && manifest.version) return manifest.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Could not find the agent-intake package.json.');
    directory = parent;
  }
}
