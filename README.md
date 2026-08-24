# pi-portr

Hand off work and ask questions across visible, independent agent sessions.

`pi-portr` is a Pi extension for coordinating work across visible, independent agent sessions. It currently uses Herdr to orchestrate Pi and Claude destinations while keeping context transfer explicit, bounded, and reviewable.

> Status: MVP delivered and actively maintained.

## Demo

https://github.com/user-attachments/assets/de9d42cc-9b28-4312-90d0-e80e122fc4f4

## Installation

```bash
pi install npm:pi-portr
```

> **Security:** Pi packages run with full system access. Review source code before installation.

Install [Herdr](https://herdr.dev), enter a Herdr-managed pane, and start Pi from inside that pane. Starting Pi outside Herdr leaves Portr without the pane context it needs.

## Quick start

Ask another agent for a read-only second opinion and wait for its answer:

```text
/portr-ask claude --wait Review the current approach and identify the main risk
```

Portr opens Claude in a new pane, sends bounded context from the current conversation, and returns the answer here. Omit `--wait` to keep working while the consultation runs.

Hand off the current task to a new agent session:

```text
/portr-pass pi Continue the current task, implement the agreed changes, and run the relevant checks
```

Portr generates a handoff from the current conversation and opens it for review. Save it to launch the destination, or cancel to stop.

## Usage

```text
/portr-pass <pi|claude> [--model <model>] <goal>
/portr-ask <pi|claude> [--model <model>] [--preview] [--no-context] [--wait] <question>
/portr-status [operation-id]
/portr-focus <operation-id>
/portr-collect <operation-id>
/portr-settings
```

`/portr-pass` builds a bounded handoff, opens it for review, and launches only after you save it. Cancel to stop without creating a destination. Pass requires a persisted origin session.

`/portr-ask` opens a read-only Pi or Claude session. It runs asynchronously by default and delivers the result as a follow-up; use `--wait` to block, `--preview` to edit the prompt, or `--no-context` to send only the question. Async Ask requires a persisted origin session.

Use `/portr-status` to inspect durable state, `/portr-focus` to return to a destination, and `/portr-collect` after resolving a blocked Ask. Status is recorded state, not live polling.

Portr preserves destination panes and limits each Herdr tab to four panes, counting all panes. Use `/portr-settings` to change the limit. Refused operations are never retried automatically.

## Explicit by default

Portr creates panes only while handling explicit `/portr-ask` or `/portr-pass` commands. It exposes neither operation as an LLM-callable tool, and reconciliation never creates panes or resends prompts.

Portr intentionally ships no default skill. To add a manual workflow, create `~/.pi/agent/skills/portr-workflow/SKILL.md`:

```markdown
---
name: portr-workflow
description: Suggests explicit pi-portr commands for consultations and handoffs.
disable-model-invocation: true
---

Choose `/portr-ask` for a read-only opinion or `/portr-pass` for a handoff.
Propose one exact command for the user to review and run. Never execute it,
invoke Herdr directly, retry refused operations, or change the pane limit.
```

## Architecture and limits

- Current scope is Pi as the origin, Herdr as the orchestration adapter, and Pi or Claude Code as destinations; `ask` is asynchronous by default.
- Context transfer is compaction-aware, semantic, and bounded. It excludes hidden reasoning and unnecessary tool output, and does not make sessions portable or replay-equivalent.
- `ask` stores append-only snapshots in the origin Pi session. Delivery is reconciliable and idempotent within the current operation-id and origin-session contract, not a universal exactly-once guarantee.
- `pass` stores the approved prompt and launch receipt, but never automatically resends an approved or failed handoff.
- Herdr is invoked with argument arrays via `execFile(..., { shell: false })`, avoiding shell interpolation; this does not make arbitrary command execution safe or sandboxed.
- Pane direction is a best-effort aspect-ratio choice from the origin pane: wide panes split right, otherwise down. Portr does not guarantee minimum resulting dimensions; zoomed or ambiguous layouts are refused before splitting.
- The pane limit controls only Portr splits. It prevents normal sequential recursion but is not an atomic cross-process maximum when multiple Portr processes split concurrently.

## Requirements

- Node.js `>=22.19.0`
- Pi `>=0.84.0`
- Herdr `>=0.8.2`
- Claude Code `>=2.1.196` when using the Claude destination

Claude Ask was validated with Claude Code `2.1.241`. It injects session-local `UserPromptSubmit`, `Stop`, and `StopFailure` hooks through `--settings`, correlates the operation with Claude's public `session_id` and `prompt_id`, and reads `last_assistant_message` from a bounded temporary receipt. It does not modify persistent Claude settings or parse Claude's internal JSONL transcript. Missing, disabled, invalid, or ambiguous hooks fail explicitly while preserving pane and session references.

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
