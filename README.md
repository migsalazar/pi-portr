# pi-portr

Hand off work and ask questions across visible, independent agent sessions.

`pi-portr` is a Pi extension that uses Herdr to launch destination agents while keeping context transfer explicit, bounded, and reviewable.

> Status: early development. The commands below are planned and not yet implemented.

## Planned commands

```text
/portr-pass <pi|claude> <goal>
/portr-ask <pi|claude> <question>
```

- **Pass** moves the continuation to another visible session after context preview.
- **Ask** runs a read-only consultation and returns a bounded answer to the origin.

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
