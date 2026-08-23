# pi-portr

Hand off work and ask questions across visible, independent agent sessions.

`pi-portr` is a Pi extension for coordinating work across visible, independent agent sessions. It currently uses Herdr to orchestrate Pi and Claude destinations while keeping context transfer explicit, bounded, and reviewable.

> Status: MVP implemented and validated for the `0.1.0` release.

## Demo

https://github.com/user-attachments/assets/de9d42cc-9b28-4312-90d0-e80e122fc4f4

## Installation

```bash
pi install npm:pi-portr
```

> **Security:** Pi packages run with full system access. Review source code before installation.

Install [Herdr](https://herdr.dev), enter a Herdr-managed pane, and start Pi from inside that pane. Starting Pi outside Herdr leaves Portr without the pane context it needs.

## Usage

```text
/portr-pass <pi|claude> [--model <model>] <goal>
/portr-ask <pi|claude> [--model <model>] [--preview] [--no-context] [--wait] <question>
/portr-status [operation-id]
/portr-focus <operation-id>
/portr-collect <operation-id>
/portr-settings
```

Pass builds a bounded semantic handoff from the active Pi context, opens it for review, and starts a visible destination through Herdr after approval. Pass requires a persisted origin session. Saving the editor records the exact approved prompt before launch; cancelling records nothing and creates no destination. Append-only receipts preserve delivery, focus, and destination references without replaying an ambiguous handoff. After delivery, Portr focuses the destination only if the origin pane is still focused, so switching elsewhere during launch is respected.

Ask starts Pi with only `read`, `grep`, `find`, and `ls`, or Claude with only `Read`, `Grep`, and `Glob`; Claude MCP tools are denied and permission prompts are auto-denied. By default ask returns after dispatch, persists the operation in the origin session, and later delivers one bounded result as a follow-up. Extension reloads and origin-session restarts reconcile unfinished operations without resubmitting the question. A destination that requires intervention remains durably `blocked`; after resolving it in the destination, `/portr-collect <operation-id>` inspects and collects the result without replaying the prompt. Add `--no-context` to send only the question and consultation policy, or `--wait` for the blocking variant.

`/portr-status` reports append-only state from the active origin branch; it does not poll destinations. The footer summarizes durable active and blocked Ask counts using the same state. `/portr-focus` focuses the destination recorded for an exact operation ID without changing its durable state.

Destination panes and sessions are intentionally preserved after completion and after partial or uncertain failures.

Portr limits the current Herdr tab to four panes by default, counting panes regardless of who created them. Before each Ask or Pass split, it divides the origin pane along its longer visual side (`right` when its width is at least twice its height, otherwise `down`). At the configured limit, Portr refuses before creating a pane and tells the caller not to retry automatically. Use `/portr-settings` to change the limit. Pi can also inspect the setting or request a human-approved change through the discoverable `portr_settings` tool; ask Pi, for example, "How do I let pi-portr use more panes?"

The setting is stored in Portr's own global `portr.json` under Pi's agent directory (normally `~/.pi/agent/portr.json`). Portr never raises the limit automatically, retries a refused operation, or closes an existing pane.

## Architecture and limits

- Current scope is Pi as the origin, Herdr as the orchestration adapter, and Pi or Claude Code as destinations; `ask` is asynchronous by default.
- Context transfer is compaction-aware, semantic, and bounded. It excludes hidden reasoning and unnecessary tool output, and does not make sessions portable or replay-equivalent.
- `ask` stores append-only snapshots in the origin Pi session. Delivery is reconciliable and idempotent within the current operation-id and origin-session contract, not a universal exactly-once guarantee.
- `pass` stores the approved prompt and launch receipt, but never automatically resends an approved or failed handoff.
- Herdr is invoked with argument arrays via `execFile(..., { shell: false })`, avoiding shell interpolation; this does not make arbitrary command execution safe or sandboxed.
- The pane limit controls only Portr splits. It prevents normal sequential recursion but is not an atomic cross-process maximum when multiple Portr processes split concurrently.

## Requirements

- Node.js `>=22.19.0`
- Pi `>=0.84.0`
- Herdr `>=0.8.2`
- Claude Code when using the Claude destination

The current Claude integration was validated with Claude Code `2.1.239`. Result extraction reads Claude Code's local JSONL transcript and validates durable completion markers strictly. That schema is internal and may change between Claude Code versions; incompatible schema drift fails explicitly while preserving pane and session references.

Ask restrictions are harness-level policy, not an operating-system sandbox.

## Development

```bash
npm ci --ignore-scripts
npm run check
npm pack --dry-run
```

Live integration tests are opt-in, must run from a Herdr-managed pane, and may incur model-provider costs:

```bash
PORTR_RUN_MODEL_INTEGRATION=1 \
PORTR_INTEGRATION_TARGET=pi \
PORTR_INTEGRATION_FLOW=pass \
npm run test:integration
```

Targets are `pi` or `claude`; flows are `pass` or `ask`.
