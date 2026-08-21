# pi-portr

Hand off work and ask questions across visible, independent agent sessions.

`pi-portr` is a Pi extension that uses Herdr to launch destination agents while keeping context transfer explicit, bounded, and reviewable.

> Status: early development. Pi and Claude pass and ask destinations are implemented.

## Usage

```text
/portr-pass <pi|claude> [--model <model>] <goal>
/portr-ask <pi|claude> [--model <model>] [--preview] <question>
/portr-ask <pi|claude> [--model <model>] [--preview] --wait <question>
```

Pass builds a bounded semantic handoff from the active Pi context, opens it for review, and starts a visible Pi destination through Herdr after approval.

Ask starts Pi with only `read`, `grep`, `find`, and `ls`, or Claude with only `Read`, `Grep`, and `Glob`; Claude MCP tools are denied and permission prompts are auto-denied. By default ask returns after dispatch, persists the operation in the origin session, and later delivers one bounded result as a follow-up. Extension reloads and origin-session restarts reconcile unfinished operations without resubmitting the question. Add `--wait` for the blocking variant.

## Initial scope

- Pi as the origin harness
- Herdr as the workspace backend
- Pi and Claude Code as destinations
- Compaction-aware context without hidden reasoning or unnecessary tool output
- Asynchronous ask by default

## Requirements

- Node.js `>=22.19.0`
- Pi `>=0.84.0`
- Herdr
- Claude Code when using the Claude destination

See [`docs/implementation-plan-mvp.md`](docs/implementation-plan-mvp.md) for the implementation plan.
