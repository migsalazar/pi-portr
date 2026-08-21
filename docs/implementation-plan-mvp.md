# pi-portr MVP implementation plan

Status: MVP implemented and release-ready

## 1. Objective

`pi-portr` transfers explicit, reviewable context from a Pi session to another visible and independent agent session managed by Herdr.

The MVP provides two operations:

- `/portr-pass`: move the continuation to another session;
- `/portr-ask`: consult another session and return a bounded answer to the origin.

Pi is the only origin harness. Pi and Claude Code are destination harnesses. Herdr is the only workspace backend.

## 2. Product behavior

### Pass

```text
Pi origin -- approved semantic context --> destination
                                               ^
                                               |
                                             user
```

- Generate a semantic handoff from the active Pi context.
- Show it in an editor before launching the destination.
- Saving the editor confirms the exact transfer; cancelling stops the operation.
- Launch the destination in a visible pane.
- Focus the destination only after its prompt is delivered successfully.
- Keep the origin session intact.
- Do not return a result automatically.

### Ask

```text
Pi origin -- question + bounded context --> destination
Pi origin <-- bounded answer -------------- destination
```

- Launch the destination under a read-only harness policy.
- Keep the destination visible and independent.
- Return control to the origin after dispatch by default.
- Support `--wait` for explicit blocking behavior.
- Return a bounded answer to the correct origin session.
- Keep a durable reference to the full destination session.

## 3. MVP scope

Included:

- `/portr-pass pi`;
- `/portr-pass claude`;
- `/portr-ask pi`;
- `/portr-ask claude`;
- asynchronous ask by default;
- blocking ask with `--wait`;
- optional ask preview with `--preview`;
- optional destination model with `--model`;
- compaction-aware origin context;
- explicit filtering of hidden or oversized content;
- durable state for asynchronous asks;
- bounded answer delivery;
- observable failures that preserve destination panes and sessions.

Excluded:

- `/portr-task`;
- write-capable delegated work;
- worktrees and conflict handling;
- alternative workspace backends;
- custom context providers;
- custom prompt templates;
- target presets;
- interactive operation dashboards;
- automatic pane cleanup;
- generated summaries of oversized return answers;
- broad cross-platform guarantees before real testing.

## 4. Initial scaffold

```text
pi-portr/
├── docs/
│   └── implementation-plan-mvp.md
├── src/
│   ├── index.ts
│   ├── commands/
│   │   ├── pass.ts
│   │   └── ask.ts
│   ├── context.ts
│   ├── herdr.ts
│   ├── pi-target.ts
│   └── state.ts
├── tests/
│   ├── context.test.ts
│   └── herdr.test.ts
├── package.json
├── tsconfig.json
├── README.md
└── LICENSE
```

Keep related implementation together until a file has multiple independent responsibilities or real duplication appears. Add a Claude-specific module when the Claude vertical slice starts. Do not create generic backend, policy, template, or target frameworks in the initial scaffold.

## 5. Package baseline

- package: `pi-portr`;
- license: MIT;
- module format: ESM;
- Node.js: `>=22.19.0`;
- peer dependency: `@earendil-works/pi-coding-agent *`, as required for Pi core packages;
- extension entrypoint: TypeScript loaded by Pi;
- Herdr: external runtime prerequisite, version `>=0.8.0`, not installed by `pi-portr`.

The implementation targets Herdr CLI `0.8.0` or newer. In particular, pass relies on `agent prompt --wait` observing a state transition and returning `working` or `blocked` after one submission.

## 6. Command surface

```text
/portr-pass <pi|claude> [--model <model>] <goal>
/portr-ask <pi|claude> [--model <model>] [--preview] [--wait] <question>
```

The parser treats all remaining text as the goal or question. The MVP does not expose context-policy or return-policy selection.

Defaults:

- cwd: origin session cwd;
- pass context: generated semantic handoff;
- ask context: bounded active conversation;
- ask execution: asynchronous;
- ask return: bounded final answer plus a durable destination reference.

## 7. Context handling

### Active Pi context

Use Pi's session APIs rather than manually parsing JSONL:

```text
ctx.sessionManager.getEntries()
ctx.sessionManager.getLeafId()
buildSessionContext(entries, leafId)
```

The resulting context must follow the active branch and respect compaction summaries.

### Filtering

Before context enters a prompt:

- include relevant user and assistant text;
- exclude assistant thinking/reasoning blocks;
- exclude base64 image payloads;
- exclude hidden extension messages by default;
- omit or tightly bound tool-result bodies;
- preserve useful file references and compact tool metadata;
- apply a deterministic character or byte budget;
- report the approximate transfer size to the user.

A deterministic character or byte limit is sufficient for the MVP. A tokenizer dependency is not required.

### Pass context

Generate one semantic handoff containing:

- current objective;
- decisions already made;
- constraints;
- relevant files and observed state;
- completed work;
- next action;
- unresolved questions.

The generated handoff is opened in Pi's editor. Saving confirms it; cancellation creates no destination.

### Ask context

Use a bounded active-conversation representation plus the explicit question. The destination prompt clearly separates quoted origin context from instructions.

### Return context

Return the destination's final answer when it fits the budget. If it is too large:

- return a clearly labelled bounded excerpt;
- state that the result was abbreviated;
- include operation and destination references in message metadata;
- keep the complete destination session available for inspection.

Do not make a second model call to summarize an oversized answer in the MVP.

## 8. Concrete Herdr integration

`src/herdr.ts` owns the concrete CLI integration.

Responsibilities:

- verify that the extension is running inside Herdr;
- verify that the `herdr` executable is available;
- invoke commands with argument arrays and no shell interpolation;
- parse Herdr JSON envelopes;
- preserve original diagnostics in normalized errors;
- support explicit timeouts and cancellation;
- return opaque pane, agent, and session identifiers;
- preserve destination state after uncertain or partial failure.

Required operations:

```text
current pane
split pane without focus
start Pi or Claude
prompt and wait
read final status
read recent destination output
focus destination
```

Use a fixed split direction for the first implementation. Layout-aware split selection is not part of the MVP.

## 9. Target policies

### Pi ask

Launch Pi with the documented read-only allowlist:

```text
--tools read,grep,find,ls
```

Do not expose bash, edit, write, or unrelated extension tools. Preserve the Herdr integration required for lifecycle reporting.

For authoritative result extraction:

- obtain the child Pi session path from Herdr;
- open it through Pi's `SessionManager` APIs;
- reconstruct its active context;
- select the final completed assistant answer.

### Pi pass

Launch a fresh normal Pi session with the approved handoff as its initial prompt. Apply `--model` only when explicitly provided. Track parent/child association in the operation metadata; Pi session-header linkage is not required for the first slice.

### Claude ask

Launch Claude with:

- built-in tools restricted to `Read`, `Grep`, and `Glob`;
- MCP tools denied;
- permission mode `dontAsk`;
- an explicit no-modification instruction;
- Herdr lifecycle hooks preserved.

This is a harness-level policy, not an operating-system sandbox.

Claude result extraction must be tested with long and tool-heavy answers. If Herdr terminal output is incomplete or ambiguous, add the smallest explicit result delimiter or artifact needed for reliable extraction.

### Claude pass

Launch a fresh normal Claude session with the approved handoff. Do not apply ask's read-only restrictions.

## 10. Ask operation state

Persist asynchronous ask metadata as Pi custom entries that do not enter model context.

Minimal states:

```text
working
blocked
completed
failed
delivered
```

A failed operation carries a structured reason such as:

```text
launch_failed
prompt_failed
timeout
result_unavailable
cancelled
```

Minimum operation record:

```text
operationId
originSession
originCwd
targetKind
agentName
paneId
childSession
status
failureReason
createdAt
updatedAt
deliveredAt
```

Requirements:

- append state transitions instead of relying only on in-memory promises;
- deliver a completed result at most once;
- never deliver into a different origin session;
- reconcile unfinished operations when the matching origin session starts;
- treat `blocked` as requiring intervention, not as completion;
- preserve pane and child session references after failure or delivery.

Use a visible custom message for returned context:

```text
deliverAs: followUp
triggerTurn: true
```

This allows an active origin turn to finish before the consultation result is processed.

## 11. Vertical implementation slices

### Slice 0 — Minimal package (complete)

Deliver:

- package metadata;
- TypeScript configuration;
- extension entrypoint;
- test, typecheck, lint/format, and aggregate check scripts;
- minimal README and MIT license.

Verify:

- Pi loads the extension;
- normal tests do not invoke paid models;
- dry-run package contents contain only intended files.

### Slice 1 — Pi-to-Pi pass (complete)

Deliver one complete user flow:

1. parse `/portr-pass pi`;
2. extract and filter active context;
3. generate semantic handoff;
4. open editor and treat save as confirmation;
5. preflight Herdr;
6. split without focus using a fixed direction;
7. launch Pi and submit the approved handoff;
8. focus only after successful prompt delivery.

Verify manually:

- the destination is visible and immediately usable;
- the origin remains intact;
- cancelled preview creates no pane;
- hidden reasoning is absent;
- partial failures preserve diagnostics.

### Slice 2 — Pi-to-Pi blocking ask (complete)

Implement the complete ask pipeline using `--wait`:

1. construct bounded context and question;
2. launch read-only Pi;
3. wait for Herdr lifecycle completion;
4. distinguish blocked, failed, and completed;
5. extract the final answer from the child Pi session;
6. return a bounded result to the origin.

This slice validates the transport and result contract before background lifecycle complexity is introduced.

### Slice 3 — Pi-to-Pi asynchronous ask (complete)

Make ask asynchronous by default:

1. persist the operation before returning;
2. monitor completion in the extension runtime;
3. deliver through `pi.sendMessage()` as a follow-up;
4. persist delivery state;
5. reconcile after extension reload or origin restart;
6. prove idempotent delivery.

Keep `--wait` as the blocking variant.

### Slice 4 — Claude destination (complete)

Add Claude-specific launch and result behavior:

1. Claude pass;
2. Claude blocking ask;
3. Claude result-extraction reliability tests;
4. Claude asynchronous ask using the established operation lifecycle.

Do not generalize target or backend interfaces unless the Pi and Claude implementations demonstrate a stable shared contract.

## 12. Testing

### Unit tests

`tests/context.test.ts` covers:

- active branch and compaction behavior;
- thinking removal;
- image-payload removal;
- tool-output bounds;
- deterministic output limits;
- oversized answer excerpts.

`tests/herdr.test.ts` uses a fake Herdr executable or process seam to cover:

- exact argument arrays;
- spaces and newlines in prompts and cwd;
- malformed JSON;
- missing executable;
- timeout;
- blocked status;
- partial launch failure.

`tests/state.test.ts` covers:

- versioned operation restoration from the active branch;
- malformed snapshot rejection;
- durable result-message detection;
- follow-up delivery options;
- idempotent recovery when delivery was already persisted.

### Integration tests

Integration tests are opt-in and run inside a dedicated Herdr environment. The parameterized live runner covers:

- split, start, one-shot prompt acknowledgment, and wait;
- Pi or Claude durable child-session extraction;
- pass or blocking-ask launch policy;
- preservation of the destination pane for inspection.

Asynchronous origin reload/restart reconciliation remains covered by deterministic lifecycle tests and has been validated interactively.

Tests that call models require `PORTR_RUN_MODEL_INTEGRATION=1`, an explicit target and flow, and are never part of the default unit-test command.

## 13. Failure behavior

For every operation, report which stage failed and any safe references already created.

- Never report truncated or ambiguous output as a complete result.
- Never treat `blocked` or `unknown` as success.
- Never focus a pass destination before prompt delivery succeeds.
- Never destroy panes or child sessions automatically after uncertain failure.
- Never inject a full destination transcript into the origin model context.
- Never log transferred context by default.

## 14. MVP acceptance criteria

### Pass

```text
/portr-pass <pi|claude> <goal>
```

opens a visible, independent destination session containing the exact handoff approved in the editor. The destination is usable immediately and the origin remains intact.

### Ask

```text
/portr-ask claude <question>
```

returns after dispatch, leaves the origin usable, runs Claude under the documented read-only policy, and later delivers one bounded result to the correct origin session. The complete destination state remains inspectable.

### Quality bar

- no hidden reasoning or base64 payload transfer;
- no inferred write permission for ask;
- no silent result truncation;
- deterministic context bounds;
- observable partial failures;
- preserved source and destination sessions;
- tested asynchronous idempotency and restart recovery;
- passing typecheck, lint/format, unit tests, and package dry run.

## 15. Next implementation action

Prepare the `0.1.0` release: add repository metadata after choosing a public remote, review the final package diff, and tag and publish only with explicit approval.
