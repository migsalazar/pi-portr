# pi-portr

Hand off work and ask questions across visible, independent agent sessions.

`pi-portr` is a Pi extension with two flows: `pass` moves a reviewed continuation to another visible session, and `ask` consults another visible session and brings back one bounded answer. The implementation uses concrete adapters for Herdr orchestration and Pi or Claude destinations while keeping context transfer explicit, bounded, and reviewable.

> Status: MVP implemented and validated for the `0.1.0` release.

## Installation

From a local checkout:

```bash
pi install /absolute/path/to/pi-portr
```

To try it for one Pi run without changing package settings:

```bash
pi -e /absolute/path/to/pi-portr
```

After the package is published to npm:

```bash
pi install npm:pi-portr@0.1.0
```

Pi packages execute with full user permissions. Review the source before installation.

`pi-portr` must run in a Pi session inside a Herdr-managed pane.

## Usage

```text
/portr-pass <pi|claude> [--model <model>] <goal>
/portr-ask <pi|claude> [--model <model>] [--preview] <question>
/portr-ask <pi|claude> [--model <model>] [--preview] --wait <question>
```

Pass builds a bounded semantic handoff from the active Pi context, opens it for review, and starts a visible destination through Herdr after approval. Saving the editor confirms delivery; cancelling creates no destination. After delivery, Portr focuses the destination only if the origin pane is still focused, so switching elsewhere during launch is respected.

Ask starts Pi with only `read`, `grep`, `find`, and `ls`, or Claude with only `Read`, `Grep`, and `Glob`; Claude MCP tools are denied and permission prompts are auto-denied. By default ask returns after dispatch, persists the operation in the origin session, and later delivers one bounded result as a follow-up. Extension reloads and origin-session restarts reconcile unfinished operations without resubmitting the question. Add `--wait` for the blocking variant.

Destination panes and sessions are intentionally preserved after completion and after partial or uncertain failures.

## Architecture notes and limits

- Pi is the only origin harness; Herdr is the only orchestration adapter; Pi and Claude Code are the concrete destination adapters.
- `ask` state is persisted as append-only snapshots in the origin Pi session, not as strict event sourcing.
- Herdr is invoked with argument arrays via `execFile(..., { shell: false })`, which avoids shell interpolation. It does not make arbitrary command execution safe or sandboxed.
- Ask delivery is reconciliable and idempotent under the current operation-id and origin-session contract; it is not a universal exactly-once guarantee.
- Portr transfers semantic, bounded context and durable references. It does not make full agent sessions portable or replay-equivalent.

## Initial scope

- Pi as the origin harness
- Herdr as the workspace orchestration adapter
- Pi and Claude Code as destinations
- Compaction-aware context without hidden reasoning or unnecessary tool output
- Asynchronous ask by default

## Requirements

- Node.js `>=22.19.0`
- Pi `>=0.84.0`
- Herdr `>=0.8.2`
- Claude Code when using the Claude destination

The current Claude integration was validated with Claude Code `2.1.238`. Result extraction reads Claude Code's local JSONL transcript and validates durable completion markers strictly. That schema is internal and may change between Claude Code versions; incompatible schema drift fails explicitly while preserving pane and session references.

Ask restrictions are harness-level policy, not an operating-system sandbox.

## Testing

Default checks never invoke models:

```bash
npm run check
npm pack --dry-run
```

The live Herdr integration runner is opt-in, makes one paid model call, creates a destination pane, and intentionally preserves it for inspection. Run it from a Herdr-managed pane and select one target and flow:

```bash
PORTR_RUN_MODEL_INTEGRATION=1 \
PORTR_INTEGRATION_TARGET=pi \
PORTR_INTEGRATION_FLOW=pass \
npm run test:integration
```

`PORTR_INTEGRATION_TARGET` accepts `pi` or `claude`; `PORTR_INTEGRATION_FLOW` accepts `pass` or `ask`. Optional variables are `PORTR_INTEGRATION_MODEL`, `PORTR_INTEGRATION_TIMEOUT_MS` (maximum 300000), and `PORTR_INTEGRATION_SCENARIO` (`marker`, `short`, `long`, or `tools`). The pass flow specifically guards the one-shot prompt-acknowledgment contract: it never retries an ambiguous submission.
