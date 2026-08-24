# Workflow

- Follow vertical slices; do not create future abstractions upfront.
- Prefer small, reversible changes and inspect existing patterns first.
- For non-trivial work: research → plan → implement → verify → review.
- Read files fully before broad edits, audits, or modifying unfamiliar code.
- Ask before removing intentional functionality.
- After changes, summarize files touched, tests run, and remaining risks.

# Architecture and Safety

- Keep orchestration policy backend-neutral and isolate Herdr behind a Portr-owned contract. Add backend-specific behavior only in concrete adapters; do not add backend selection until a second implementation exists.
- Use Pi session APIs for active, compaction-aware context; do not parse JSONL for normal extraction.
- Never transfer hidden reasoning, base64 payloads, or unnecessary tool output.
- Ask targets must use harness-level read-only restrictions; this is not an OS sandbox.
- Invoke Herdr with argument arrays, never shell interpolation.
- Never report blocked, unknown, truncated, or ambiguous output as success.
- Preserve panes and sessions after partial or uncertain failures.

# TypeScript and Dependencies

- Prefer `unknown` over `any` and inspect installed declarations instead of guessing APIs.
- Use erasable TypeScript syntax; avoid constructs requiring TypeScript emit.
- Ask before adding, updating, removing, or installing dependencies.
- Pin direct dependencies exactly; use intentional ranges for peer dependencies.
- Use `--ignore-scripts` for approved npm installs unless lifecycle scripts are explicitly reviewed.

# Git

- Assume other Pi sessions may be modifying unrelated files.
- Commit or stage only explicit files from the current task.
- Never use rebase, git clean, reset --hard, force push, broad `git add`, or destructive Git commands without explicit instruction.

# Releasing

- `npm run release` and `npm run release -- vX.Y.Z` are one-shot release operations that create a version commit and tag, push `main`, then push the exact tag, triggering immutable npm and GitHub releases. Run one only after explicit user approval of the default patch bump or exact tag.
- Once the version commit or tag exists, never rerun the release script for that version. Preserve state and continue only the missing push after inspection and separate explicit approval.
- If CI fails after the tag reaches `origin`, rerun or fix GitHub Actions. Never move, delete, or force-push release tags, and never publish to npm locally.
