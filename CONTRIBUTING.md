# Contributing to AgentIntake

Thanks for helping. Bug reports, fixes, docs and new eval cases are all welcome. For a larger change, open an issue first so the approach can be agreed before you spend time on it.

## Setup

You need Node.js 22.12 or newer for the tooling (the published package also runs on 20.19+; `.nvmrc` pins 22).

```bash
git clone https://github.com/fdamianenriquez/AgentIntake.git
cd AgentIntake
npm ci
npm run build
```

To try the CLI, Studio or the demo against a real model, copy `server/.env.example` to `.env` and add a key (see "Choosing an LLM provider" in the README). The tests never need one.

## Scripts

| Script                                    | What it does                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `npm run lint` / `npm run lint:fix`       | ESLint (flat config in `eslint.config.js`)                                                    |
| `npm run format` / `npm run format:check` | Prettier                                                                                      |
| `npm run typecheck`                       | `tsc --noEmit` with TypeScript 7                                                              |
| `npm test` / `npm run test:coverage`      | Vitest                                                                                        |
| `npm run build`                           | Cleans `dist/` and compiles                                                                   |
| `npm run check:package`                   | `publint` and `arethetypeswrong` against the packed tarball                                   |
| `npm run smoke-test`                      | Packs the package, installs it into a fresh project, runs the CLI, imports and type-checks it |

TypeScript note: the project is compiled with TypeScript 7 (`@typescript/native`, which provides `tsc`). typescript-eslint needs the TypeScript compiler API, which 7.0 doesn't have, so the `typescript` dev dependency is an alias of the TypeScript 6 package (`@typescript/typescript6`), used only by the linter.

## Tests

- `npm test` makes **no real model calls**: every LLM call is mocked. Keep it that way for new tests.
- `agent-intake eval-prompts` runs cases against a real model and **spends model calls**. It is never part of `npm test` or CI. Use it to check a prompt or guidance change by hand, and add a case under `evals/cases/<call>/` when you fix a model-facing bug.
- Write a test that fails without your change before fixing a bug, and say in the PR that you saw it fail.

### Prompts and snapshots

Every prompt lives in `server/src/prompts/`, one module per LLM call, and `prompts.snapshot.test.ts` keeps a golden copy of each. A changed snapshot is a change to what the model sees, so it is always deliberate:

- update the snapshot only when you meant to change the prompt (`npx vitest run server/src/prompts -u`);
- bump that module's `PROMPT_VERSION` in the same commit (or `GUIDANCE_BLOCK_VERSION` for the guidance block's own text);
- run `eval-prompts` for the affected call and mention the result in the PR.

A refactor must leave every snapshot unchanged.

### Guardrails that tests protect

- No browser code (`studio/`, `demo/`, `packages/`, and the published `agent-intake` entry) may import `server/src/llmClient.ts`, a provider SDK, `fs` or `process.env`.
- The model can never introduce a field: output schemas use enums of real field names, and generation rehydrates field properties from the spec.
- Every LLM output schema must pass the portable-schema check (no `oneOf`, every property required or nullable, no open-ended maps).
- Studio-only routes are never mounted by `createApp()`.

## Commits and pull requests

- One logical change per commit, with a message that says what changed and why.
- Before opening a PR: `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test`. CI runs these plus the package checks.
- Add a line to `CHANGELOG.md` under an `## [Unreleased]` heading for anything a user would notice.
- Update the README when behaviour, options or environment variables change.

## Releasing

For maintainers. Releases are published by `.github/workflows/release.yml` when a version tag is pushed.

1. Update `version` in `package.json` and turn `## [Unreleased]` in `CHANGELOG.md` into `## [x.y.z] — YYYY-MM-DD`, with its link reference at the bottom. Commit to `main`.
2. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`. A version with a prerelease part (`1.1.0-rc.1`) is published with the `next` dist-tag, any other with `latest`.
3. The workflow checks that the tag matches `package.json` and that the changelog has a section for it, runs lint, typecheck, tests, build, the package checks and the smoke test, verifies registry signatures, publishes with provenance, and creates the GitHub Release with that changelog section as its notes.

### One-time setup

- **GitHub environment.** Create an environment named `npm` (Settings → Environments) and add protection rules, for example required reviewers, so a tag alone can't publish.
- **First release (token).** npm can't scope a granular access token to a package that doesn't exist yet, so create a short-lived granular token with read and write access to all packages, with "Bypass two-factor authentication" enabled if your account requires 2FA for writes. Save it as the `NPM_TOKEN` secret of the `npm` environment. The first publish creates the package; revoke the token right after trusted publishing is confirmed (next step).
- **Trusted publishing (OIDC).** After the first release, on npmjs.com open the package's settings → Trusted publishing and add a GitHub Actions publisher: repository `fdamianenriquez/AgentIntake`, workflow `release.yml`, environment `npm`. Publish the next release to confirm it works, then delete the `NPM_TOKEN` secret, revoke the token, and under Publishing access choose "Require two-factor authentication and disallow tokens".

The publish step needs no edit between the two states: npm (11.5.1 or newer) tries trusted publishing first and falls back to the token only when there is no trusted publisher.
