# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

The package version in `package.json` went from 0.1.0 straight to 1.6.0: 1.5.0 was never set there, so its entry below describes the work that shipped under that name.

## [1.6.0] — 2026-10-14

Author guidance: a flow author can adapt what the model is told for their domain, without code and without being able to change the guardrails, and check the effect before shipping.

### Added

- **Prompts module.** Every LLM prompt lives in `server/src/prompts/`, one module per call, each with a pure `build()` and a `PROMPT_VERSION`. Snapshot tests hold a golden copy of every prompt, so any change to what the model sees is deliberate.
- **Author guidance.** Slots for business context, tone, output language and extra rules per call in a global config file, plus flow-level guidance and output language and per-step guidance in `flow.json`. Guidance goes into one marked block per prompt, after the task and before the data and output rules, framed as lower priority than the prompt's own instructions. Precedence is global → flow → step; a flow's output language overrides the global one. Over-limit text, invalid language tags and unknown keys are errors, never truncated or ignored.
- **Config file.** `agentintake.config.json` (or `AGENTINTAKE_CONFIG`), validated strictly at startup by the server, Studio and the CLI, with a JSON Schema in `schemas/` for editors.
- **Trusted flows.** `AGENTINTAKE_FLOWS_DIR` makes the server use its own copies of flows for guidance; while it is set, guidance sent by the browser is never used.
- **`agent-intake eval-prompts`** and a built-in suite of 33 cases (`evals/cases/`, with fixtures in `evals/fixtures/`): runs cases with a known answer against the configured model with your guidance applied, asks before spending model calls, and reports pass rate, fallbacks, latency and failing runs per call. Exit code 1 below `--min-pass`, 2 for usage or configuration errors.
- **Studio "Instructions" tab.** Edit global guidance (saved to the config file and applied without a restart) and flow and step guidance (kept in the flow and in the downloaded `flow.json`); see the prompt a call would send with the guidance block highlighted; run the built-in cases with confirmation, progress and cancel. Regenerating in the same session keeps the guidance by endpoint id.
- **`generate --keep-guidance` / `--force`.** `generate` no longer overwrites a `flow.json` that has author guidance unless told to keep it (carried over by endpoint id, checked against the limits before the model is called) or to overwrite it.
- **Logging.** `AGENTINTAKE_LOG_LEVEL` (`error`, `warn`, `info`, `debug`). At `debug`, one line per LLM call with the call, its prompt version, the guidance block version, a short hash of the guidance block, the outcome and the duration — never guidance text, prompts or user data. The fallback warning carries the same call, versions and hash.
- **Demo.** A second demo flow with flow and step guidance and `outputLanguage: "es-MX"`.

### Changed

- **Validate prompt, `PROMPT_VERSION` 2.** Semantic validation now counts the author's guidance, not only the field descriptions, as a source of rules, so guidance can make a check stricter. This is the only change to a prompt's fixed text in this release; prompts without guidance are otherwise byte-identical to 1.5.0.
- The runtime routes accept an optional `flow: { id, guidance?, outputLanguage? }`, which the hook sends with every call; endpoint definitions may carry `guidance`. Older clients that don't send them keep working.
- The package lists the files it ships (`files` in `package.json`), including the eval cases and the JSON Schema.

### Fixed

- Fallback reasons in eval runs are captured per run without replacing `console.warn`, so overlapping runs no longer lose or mix them.
- The fallback warning gives a fixed reason (`timeout`, `invalid output`, `provider error <status>`, `aborted`, `unknown`) instead of the provider's or SDK's error message, which can include the model's raw output and, through it, values the user entered. Eval reports still get the full message.
- The cap on warnings for unknown flow ids holds when the server context is copied per request (Studio).

## [1.5.0] — 2026-10-13

Recovery and revisiting: steps map to API resources, can be revisited and changed, and a failure can be explained and, with the user's confirmation, undone.

### Added

- **Operations contract.** An endpoint takes either `execute` (as before) or `operations: { create, read?, update?, undo? }`. Operations receive `ctx.results` (what earlier steps created), a stable `idempotencyKey` and, for item operations, the `resourceId`. Helpers `failureFromResponse` and `undoResultFromResponse` map HTTP responses to results.
- **Resource families.** The parser groups `POST /P` with the operations on `P/{id}` into one step and records its `capabilities`, `resourcePath`, `idParam` and `pathParams`. Only query parameters and body properties become form fields.
- **Revisiting steps.** `goToStep`, `canGoToStep` and `cancelEdit`: a completed step can be opened again, read from the API when `read` exists, and changed with `update`; a step without `update` is read-only. Unchanged saves make no calls.
- **Cross-step review.** After a changed edit, an LLM check decides which later completed steps may no longer be right; those are marked for review (`stale`) with a reason, and the wizard takes the user through them. A step whose questions changed must be updated; one that can't be changed can be accepted with a follow-up note.
- **Failure classification and confirmed undo.** A failed step is classified as retryable, needs-edit or fundamental (deterministically where possible, otherwise by the model). For a fundamental failure the form proposes undoing earlier steps in reverse order, and runs the undo only after the user confirms.
- **CORS restriction.** `AGENTINTAKE_CORS_ORIGINS` limits which browser origins may call the runtime server; entries are normalized and an invalid entry stops startup. The README has a section on deploying the runtime server.
- Defaults of current low-cost model tiers per provider.

### Changed

- **Regenerate flows generated before resource families.** Item-path updates used to be separate steps, and path and header parameters used to be form fields.
- Every LLM output schema is kept to what all supported providers accept (no `oneOf`, no optional properties, no open-ended maps); generation works with Anthropic models and adaptive field selection with OpenAI strict mode.
- Over-long model text (review reasons, failure explanations) is cut instead of discarding an otherwise correct answer, and the prompts ask for text well under the limit.

### Fixed

- Navigation, submits and retries are locked while a failure is being classified or an undo is proposed or running; a classification that becomes irrelevant (the user edits the failed step) is cancelled.
- Steps a rollback couldn't undo are marked for review instead of being left complete; stale steps are included in the rollback range and in `ctx.results`.
- An edit is judged against what the form was prefilled with; data from `read` is merged over the local record field by field (dotted field names resolved against nested objects), and its metadata is ignored.
- A failure message is not repeated when the explanation already includes it; cancelling a review returns to the step the user came from.
- A configuration error at startup prints its message without a stack trace, in the server and in Studio.
