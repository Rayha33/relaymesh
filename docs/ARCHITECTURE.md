# RelayMesh architecture

RelayMesh is a local-first coordination runtime for AI agent sessions. It sits
between model-specific clients and durable work state so a task survives model
switches, context loss, process crashes, and uncooperative peers.

## Design invariants

1. **The event log is canonical.** Chat history is not durable coordination
   state.
2. **Agents are replaceable.** A task belongs to a mission, never to one model
   session.
3. **Retryable agent mutations are idempotent.** Clients reuse an idempotency
   key when an operation times out and must be retried.
4. **Work is leased, not assigned forever.** An expired lease returns to the
   queue with its latest checkpoint.
5. **Messages are typed and durable.** Delivery is at-least-once; acknowledgments
   make replay safe.
6. **Artifacts are content-addressed.** Messages reference artifact hashes
   instead of embedding mutable blobs.
7. **Authority is explicit.** Session tokens are scoped to a mission and role.
8. **Human intervention remains possible.** Operators can pause or cancel
   missions, revoke agent identities, run recovery, and inspect the event trail.

## Components

```text
Claude / Codex / Gemini / custom agents
          | REST SDK / MCP tools
          v
 +-----------------------+
 | RelayMesh gateway     |
 | auth · validation     |
 +-----------+-----------+
             |
 +-----------v-----------+
 | Coordination runtime  |
 | scheduler · inbox     |
 | leases · checkpoints  |
 | recovery · artifacts  |
 +-----------+-----------+
             |
 +-----------v-----------+
 | SQLite event store    |
 | WAL · hash chain      |
 +-----------+-----------+
             |
 +-----------v-----------+
 | Operator dashboard    |
 +-----------------------+
```

## Mission state machine

`draft -> active <-> paused -> completed | failed | cancelled`

A mission completes automatically when every task completes. An exhausted task
fails the mission and cancels remaining work. Cancelling a mission releases all
active leases before cancelling unfinished tasks, so late completions are
fenced.

## Task state machine

`queued -> leased -> running -> completed | failed | cancelled`

- `queued`: eligible agents may claim the task.
- `leased`: a session owns the task for a bounded interval.
- `running`: the session has confirmed work started.
- lease expiry from `leased` or `running`: task is requeued and the attempt is
  incremented.
- attempts beyond `maxAttempts`: task becomes `failed`.

## Session liveness

Agents send a heartbeat while joined. A session is considered lost when:

```text
now - lastHeartbeat > heartbeatTimeout
```

The recovery sweeper marks the session `lost`, expires its task leases, and
requeues recoverable work. The latest checkpoint is attached to the requeued
task so a different model can resume without reconstructing the whole chat.

## Cooperation model

Agents advertise capabilities when joining:

```json
["research.web", "code.typescript", "test.browser"]
```

Tasks declare required capabilities. Claiming uses set inclusion: the session
must satisfy every requirement. Models can communicate through durable messages
with one of these intents:

- `inform`
- `request`
- `response`
- `challenge`
- `decision`
- `handoff`
- `blocker`

Messages can target a session, a role, or the mission broadcast channel.

## Crash semantics

RelayMesh provides **at-least-once work delivery**. Exactly-once model execution
is impossible when a model or network can fail after doing work but before
reporting it. RelayMesh instead provides:

- idempotency keys for every mutation;
- leased tasks with fencing tokens;
- checkpoint-before-side-effect guidance;
- content hashes for artifacts;
- a tamper-evident event trail;
- stale-fence rejection after a task is re-leased.

This prevents a recovered agent from accepting a late completion from the
crashed session.

## Storage

SQLite runs in WAL mode with foreign keys and a busy timeout. The single-node
runtime is intentionally operational without external infrastructure. The
protocol and service boundary permit replacing SQLite with PostgreSQL or a
distributed log later without changing agent clients.
