# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.1] — 2026-10-17

### Fixed

- `agent-intake --version` printed `1.6.0`; it now prints the installed package's version.

## [1.0.0] — 2026-10-17

First public release: an OpenAPI spec becomes a multi-step form wizard whose fields and checks adapt at runtime, with every model call made server-side through structured output.

### Added

- **Flow generation.** `agent-intake generate` and Studio parse an OpenAPI 3 spec into one step per resource and let the model group, order and word the steps. The model can only reword and reorder: field types, required flags, enum values and validation always come from the spec. Ambiguous fields are flagged for review.
- **Resource families.** `POST /P` is grouped with the operations on `P/{id}` into one step, with its `capabilities` (read/update/undo), `resourcePath`, `idParam` and `pathParams`. Only query parameters and body properties become form fields; header and cookie parameters never do.
- **React package.** `AgentIntakeForm` and the `useAgentForm` hook render one step per endpoint with generic field controls, client-side checks before any network call, and a `StepStatus` lifecycle in which only a successful create completes a step.
- **Adaptive fields and semantic validation.** Per step, the model chooses which of the step's own fields apply given earlier answers (it can never add one) and checks whether the answers are plausible, including against earlier steps.
- **Operations contract.** An endpoint takes `execute` or `operations: { create, read?, update?, undo? }`. Operations run in the browser and receive `ctx.results` from earlier steps, a stable `idempotencyKey` and, for item operations, the `resourceId`. `failureFromResponse` and `undoResultFromResponse` map HTTP responses to results.
- **Revisiting steps.** `goToStep`, `canGoToStep` and `cancelEdit`: a completed step can be opened again, read from the API when `read` exists and changed with `update`; without `update` it is read-only. Unchanged saves make no calls.
- **Cross-step review.** After a changed edit, a model check decides which later completed steps may no longer be right; they are marked for review with a reason. A step whose questions changed must be updated; one that can't be changed can be accepted with a follow-up note.
- **Failure classification and confirmed undo.** A failed step is classified as retryable, needs-edit or fundamental, deterministically where possible and otherwise by the model. For a fundamental failure the form proposes undoing earlier steps in reverse order and runs the undo only after the user confirms; navigation is locked while that is pending.
- **Studio** (`agent-intake studio`): a local web app to set up a provider, paste or upload a spec, generate a flow, try it in a live preview with simulated operations and download `flow.json`.
- **Author guidance.** Business context, tone, output language and extra rules per call in `agentintake.config.json`, plus flow-level guidance and output language and per-step guidance in `flow.json`, rendered into one marked block per prompt that ranks below the prompt's own instructions. Over-limit text, invalid language tags and unknown keys are errors.
- **Trusted flows.** `AGENTINTAKE_FLOWS_DIR` makes the server use its own copies of flows for guidance; while it is set, guidance sent by the browser is never used.
- **`agent-intake eval-prompts`** and a built-in suite of 33 cases: runs cases with a known answer against the configured model with your guidance applied, asks before spending model calls, and reports pass rate, fallbacks, latency and failing runs per call.
- **Studio "Instructions" tab** to edit global, flow and step guidance, view the prompt a call would send with the guidance block highlighted, and run the built-in cases.
- **`generate --keep-guidance` / `--force`** for regenerating a `flow.json` that has author guidance.
- **Server entry point.** `agent-intake/server` exports `createApp()`, the runtime routes as an Express app to mount behind your own middleware.
- **Graceful degradation.** If an adaptive-fields or validation call fails or times out, the step falls back to its full field list and client-side checks; `AGENTINTAKE_STATIC_MODE` skips those calls entirely. Generation is cancelled after 120 seconds.
- **Providers.** Anthropic, OpenAI, Google and OpenRouter through the Vercel AI SDK, with low-cost defaults per provider; every output schema is kept to what all of them accept.
- **Logging.** `AGENTINTAKE_LOG_LEVEL`; at `debug`, one line per model call with its prompt version, a hash of the guidance block, the outcome and the duration. A fallback warning names a fixed reason (`timeout`, `invalid output`, `provider error <status>`, `configuration error`, `aborted`, `unknown`).
- **CORS restriction.** `AGENTINTAKE_CORS_ORIGINS` limits which browser origins may call the runtime server.
- **Package.** ESM only, with type declarations; React 19 as a peer dependency; JSON Schema for the config file in `schemas/`.

### Security

- No LLM API key ever reaches the browser; every model call is made by the server.
- `/api/generate-flow` accepts spec content only, never a path or URL, and parses it with external `$ref` resolution disabled.
- Studio listens on 127.0.0.1 only and rejects requests whose `Host` isn't a loopback name or whose `Origin` isn't Studio itself; its provider-setup and guidance routes are never part of `createApp()`.
- Log lines never contain guidance text, prompts, submitted data, field values or provider error text.
- Sessions expire after 2 hours idle and are capped at 10,000.

[1.0.1]: https://github.com/fdamianenriquez/AgentIntake/releases/tag/v1.0.1
[1.0.0]: https://github.com/fdamianenriquez/AgentIntake/releases/tag/v1.0.0
