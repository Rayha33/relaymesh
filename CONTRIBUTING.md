# Contributing to RelayMesh

RelayMesh is infrastructure for unreliable and mutually untrusted AI agent
sessions. Correctness is more important than cleverness.

## Setup

```bash
npm install
npm run check
npm run demo
```

## Pull requests

1. Create a focused branch.
2. Add a failing test for protocol or recovery changes.
3. Preserve idempotency, mission isolation, and fencing semantics.
4. Update protocol, architecture, or threat-model documentation when behavior
   changes.
5. Run `npm run check` and `npm run test:coverage`.

## Invariants

- No task can have two active leases.
- A stale fencing token can never mutate task state.
- An agent cannot read or write another mission.
- Every accepted coordination mutation emits an event.
- Credentials and artifact content never enter event payloads.
- Recovery must preserve the latest checkpoint.
- Model output is untrusted input.

## Commit style

Use concise imperative commit messages, for example:

```text
Add stale-lease recovery fencing
```

## Good first contributions

- Python SDK parity
- PostgreSQL storage adapter
- additional MCP client examples
- accessibility improvements
- connector-specific idempotency adapters
- property-based state-machine tests
