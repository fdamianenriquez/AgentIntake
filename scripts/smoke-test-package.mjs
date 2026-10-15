// Installs the packed package into a fresh project and uses it the way a
// consumer would: runs the CLI, imports every entry point from plain Node ESM,
// and type-checks a small TypeScript file against the published types with
// both "bundler" and "node16" module resolution.
//
//   node scripts/smoke-test-package.mjs              packs the repo first
//   node scripts/smoke-test-package.mjs <tarball>    uses an existing tarball
//   SMOKE_SKIP_TYPES=1 node scripts/...              skips the type check
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const work = mkdtempSync(path.join(tmpdir(), 'agent-intake-smoke-'));

function run(command, args, cwd) {
  console.log(`$ ${command} ${args.join(' ')}`);
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout);
    throw new Error(`${command} ${args.join(' ')} failed`, { cause: error });
  }
}

function step(name) {
  console.log(`\n== ${name}`);
}

try {
  let tarball = process.argv[2] && path.resolve(process.argv[2]);
  if (!tarball) {
    step('Pack');
    run(npm, ['pack', '--pack-destination', work], repoRoot);
    const packed = readdirSync(work).find((name) => name.endsWith('.tgz'));
    if (!packed) throw new Error('npm pack produced no tarball.');
    tarball = path.join(work, packed);
  }

  step('Install into a fresh project');
  const app = path.join(work, 'consumer');
  mkdirSync(app);
  writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }, null, 2));
  // React comes in as a peer dependency, installed by npm on its own.
  run(npm, ['install', '--no-audit', '--no-fund', tarball], app);

  step('CLI');
  const help = run(npx, ['--no-install', 'agent-intake', '--help'], app);
  for (const command of ['generate', 'studio', 'eval-prompts']) {
    if (!help.includes(command)) throw new Error(`agent-intake --help does not list "${command}".`);
  }

  step('Import every entry point from Node ESM');
  writeFileSync(
    path.join(app, 'imports.mjs'),
    `
import * as main from 'agent-intake';
import * as server from 'agent-intake/server';
import schema from 'agent-intake/schemas/agentintake.config.schema.json' with { type: 'json' };
import manifest from 'agent-intake/package.json' with { type: 'json' };

const expect = (ok, what) => { if (!ok) throw new Error(what); };
for (const name of ['AgentIntakeForm', 'useAgentForm', 'FieldControl', 'failureFromResponse', 'undoResultFromResponse']) {
  expect(typeof main[name] === 'function', 'agent-intake does not export ' + name);
}
expect(typeof server.createApp === 'function', 'agent-intake/server does not export createApp');
expect(typeof server.createApp({ config: null, trustedFlows: null, warnOpenCors: false }).listen === 'function', 'createApp() did not return an app');
expect(schema.type === 'object', 'the config schema did not load');
expect(manifest.name === 'agent-intake', 'package.json did not load');
console.log('imported', Object.keys(main).length, 'exports from agent-intake and', Object.keys(server).length, 'from agent-intake/server');
`
  );
  process.stdout.write(run(process.execPath, ['imports.mjs'], app));

  if (process.env.SMOKE_SKIP_TYPES) {
    console.log('\nSkipping the type check (SMOKE_SKIP_TYPES).');
  } else {
    step('Type-check a consumer');
    run(npm, ['install', '--no-audit', '--no-fund', '--save-dev', '@types/react@^19', '@types/node'], app);
    writeFileSync(
      path.join(app, 'consumer.ts'),
      `
import { AgentIntakeForm, failureFromResponse, useAgentForm, type FlowDef, type OperationFailure } from 'agent-intake';
import { createApp, type CreateAppOptions } from 'agent-intake/server';

const flow: FlowDef = { id: 'f', title: 'F', description: '', endpoints: [] };
const options: CreateAppOptions = { config: null, trustedFlows: null };
const app = createApp(options);
const result: Promise<OperationFailure> = failureFromResponse(new Response(null, { status: 500 }));
export { AgentIntakeForm, app, flow, result, useAgentForm };
`
    );
    const tsc = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
    for (const [module, moduleResolution] of [
      ['esnext', 'bundler'],
      ['node16', 'node16'],
    ]) {
      writeFileSync(
        path.join(app, 'tsconfig.json'),
        JSON.stringify(
          {
            compilerOptions: {
              module,
              moduleResolution,
              target: 'es2022',
              lib: ['es2022', 'dom'],
              strict: true,
              noEmit: true,
              skipLibCheck: false,
              types: ['node'],
            },
            files: ['consumer.ts'],
          },
          null,
          2
        )
      );
      run(tsc, ['-p', 'tsconfig.json'], app);
      console.log(`types OK with moduleResolution "${moduleResolution}"`);
    }
  }

  console.log('\nSmoke test passed.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
