# pi-portr

Hand off work and ask questions across visible, independent agent sessions.

`pi-portr` is a Pi extension that uses Herdr to launch destination agents while keeping context transfer explicit, bounded, and reviewable.

> Status: early development. Pi-to-Pi pass and blocking Pi-to-Pi ask are implemented; asynchronous ask and Claude destinations remain planned.

## Usage

```text
/portr-pass pi [--model <model>] <goal>
/portr-ask pi [--model <model>] [--preview] --wait <question>
```

Pass builds a bounded semantic handoff from the active Pi context, opens it for review, and starts a visible Pi destination through Herdr after approval.

Blocking ask starts Pi with only `read`, `grep`, `find`, and `ls`, waits for completion, extracts the final answer from the child Pi session, and returns a bounded result with destination references.

Planned MVP behavior:

```text
/portr-pass claude <goal>
/portr-ask pi <question>                # asynchronous by default
/portr-ask claude [--wait] <question>
```

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
