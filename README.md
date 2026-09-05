# pi-portr

Hand off work and ask questions across visible, independent agent sessions.

`pi-portr` is a Pi extension for coordinating work across visible, independent agent sessions. It currently uses Herdr to orchestrate Pi, Claude Code, and Codex destinations while keeping context transfer explicit, bounded, and reviewable.

> Status: MVP delivered and actively maintained.

## Demo

https://github.com/user-attachments/assets/de9d42cc-9b28-4312-90d0-e80e122fc4f4

## Installation

```bash
pi install npm:pi-portr
```

> **Security:** Pi packages run with full system access. Review source code before installation.

Install [Herdr](https://herdr.dev), enter a Herdr-managed pane, and start Pi from inside that pane. Starting Pi outside Herdr leaves Portr without the pane context it needs.

Install whichever Herdr integrations correspond to the destinations you use:

```bash
herdr integration install pi
herdr integration install claude
herdr integration install codex
```

These are one-time, user-level setup commands that let Herdr report native session references to Portr. Review and trust the installed Herdr hooks when Codex first prompts. Portr disables Codex's startup update prompt for destination sessions, but it never bypasses hook trust.

## Quick start

Ask another agent for a read-only second opinion and wait for its answer:

```text
/portr-ask claude --wait Review the current approach and identify the main risk
```

Portr automatically summarizes relevant conversation context, opens Claude in a new pane, and sends the summary with your question without opening an editor. The answer returns here. Omit `--wait` to keep working after dispatch while the consultation runs.

Hand off the current task to a new agent session:

```text
/portr-pass pi Continue the current task, implement the agreed changes, and run the relevant checks
```

Portr generates a handoff from the current conversation and opens it for review. Save it to launch the destination, or cancel to stop.

## Usage

```text
/portr-pass <pi|claude|codex> [--model <model>] [--cwd <path>] <goal>
/portr-ask <pi|claude|codex> [--model <model>] [--preview] [--no-context] [--wait] <question>
/portr-status [operation-id]
/portr-focus <operation-id>
/portr-collect <operation-id>
/portr-settings
```

`/portr-pass` builds a bounded handoff, opens it for review, and launches only after you save it. Cancel to stop without creating a destination. Pass requires a persisted origin session.

Use `--cwd` to launch Pass in an existing, user-prepared directory or Git worktree. Relative paths resolve from the origin working directory; paths containing spaces must be quoted. For example, after creating a worktree yourself:

```text
git worktree add -b feature-worktree ../feature-worktree
/portr-pass pi --cwd ../feature-worktree Continue the implementation
```

Portr never creates, integrates, or cleans up worktrees. Selecting `--cwd` does not copy uncommitted changes, staged changes, ignored files, or other filesystem state from the origin.

`/portr-ask` opens a read-only Pi, Claude Code, or Codex session. Before dispatch, it uses the currently selected Pi model to synthesize relevant context, then sends it with your original question (subject to payload sanitization), without requiring review. This adds one model call and preparation time; `--model` still selects only the destination model. The summary is instructed to preserve evidence and uncertainty, omit tool activity logs, and not answer the question. Summarization can lose detail; it is not a replay of the original conversation.

After preparation, Ask runs asynchronously by default and delivers the result as a follow-up. Use `--wait` to wait for the answer, `--preview` to edit the prepared prompt, or `--no-context` to skip both context extraction and synthesis. Empty transferable context also skips synthesis. Cancelled, failed, empty, or incomplete generation stops before creating a destination; there is no silent fallback to the raw transcript. Async Ask requires a persisted origin session.

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

- Current scope is Pi as the origin, Herdr as the orchestration adapter, and Pi, Claude Code, or Codex as destinations; `ask` is asynchronous by default.
- Context transfer is compaction-aware, semantic, and bounded. It excludes hidden reasoning and unnecessary tool output, and does not make sessions portable or replay-equivalent.
- `ask` stores append-only snapshots in the origin Pi session. New snapshots include requested destination model, source context size/truncation (before synthesis), harness-level read-only policy, and the final prompt SHA-256 without copying the full prompt. Delivery is reconciliable and idempotent within the current operation-id and origin-session contract, not a universal exactly-once guarantee.
- `pass` stores the approved prompt and launch receipt, but never automatically resends an approved or failed handoff.
- Herdr is invoked with argument arrays via `execFile(..., { shell: false })`, avoiding shell interpolation; this does not make arbitrary command execution safe or sandboxed.
- Pane direction is a best-effort aspect-ratio choice from the origin pane: wide panes split right, otherwise down. Portr does not guarantee minimum resulting dimensions; zoomed or ambiguous layouts are refused before splitting.
- The pane limit controls only Portr splits. It prevents normal sequential recursion but is not an atomic cross-process maximum when multiple Portr processes split concurrently.

## Requirements

- Node.js `>=22.19.0`
- Pi `>=0.84.0`
- Herdr `>=0.8.2`
- Claude Code `>=2.1.196` when using the Claude destination
- Codex CLI `>=0.153.3` when using the Codex destination

Claude Ask was validated with Claude Code `2.1.241`. It injects session-local `UserPromptSubmit`, `Stop`, and `StopFailure` hooks through `--settings`, correlates the operation with Claude's public `session_id` and `prompt_id`, and reads `last_assistant_message` from a bounded temporary receipt. It does not modify persistent Claude settings or parse Claude's internal JSONL transcript. Missing, disabled, invalid, or ambiguous hooks fail explicitly while preserving pane and session references.

Codex Ask was validated with Codex CLI `0.153.3` and Herdr's Codex integration `v8`. It launches with `--sandbox read-only --ask-for-approval never`, disables auto-review escalation, correlates the exact submitted prompt by SHA-256, and reads only a completed `final_answer` from Codex's official app-server `thread/read` response. Interrupted, failed, in-progress, empty, mismatched, oversized, or ambiguous results fail explicitly. Portr does not parse Codex's internal JSONL transcript.

Ask restrictions are harness-level policy. Codex additionally enforces local command access with its operating-system sandbox; this is not a complete sandbox for every external integration a harness may expose.

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

Targets are `pi`, `claude`, or `codex`; flows are `pass` or `ask`.
