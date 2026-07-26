# RelayMesh architecture

RelayMesh is a provider-neutral coordination plane for AI agent sessions. A
model sees one canonical sync envelope; the runtime owns task exclusivity,
heartbeats, recovery, and handoff.

## Design invariants

1. Chat history is not shared state; the signed event log is canonical.
2. A task belongs to a mission, never to a provider session.
3. Sync returns one authoritative state and never creates duplicate claims.
4. Work is leased and fenced, not permanently assigned.
5. Handoff checkpoints, releases, retargets, and notifies atomically.
6. Connection recovery is persisted, not held in adapter memory.
7. Messages are typed and durable; artifacts are content-addressed.
8. Provider adapters cannot weaken runtime ownership rules.
9. Downstream tasks receive completed dependency outputs without provider chat.
10. A mission exposes one durable final result plus measurable productivity.
11. Multi-model defaults include an explicit disagreement-resolution gate.
12. Portable context is canonicalized, credential-free, and Ed25519-sealed.

## Components

```text
Claude · ChatGPT · DeepSeek · Codex · Gemini · local models
          │ MCP · A2A v1.0 · function tools · REST SDK
          ▼
┌─────────────────────────────────────────────────────┐
│ Adapter gateway                                     │
│ authentication · schemas · rate limits · discovery │
├─────────────────────────────────────────────────────┤
│ Canonical relay_sync envelope                       │
│ mission · peers · inbox · work · dependencies · fence│
├─────────────────────────────────────────────────────┤
│ Coordination runtime                                │
│ scheduler · leases · atomic handoff · recovery      │
├─────────────────────────────────────────────────────┤
│ SQLite WAL                                          │
│ durable sessions · tickets · artifacts · events    │
└─────────────────────────┬───────────────────────────┘
                          ▼
                 Operator dashboard
```

## Model lifecycle

```text
connect
  │
  ▼
relay_sync ── no compatible work ──> waiting ──> relay_sync
  │
  └── work + checkpoint + dependency outputs + fence
          │
          ├── checkpoint ──> continue
          ├── handoff ─────> target model relay_sync
          ├── complete ────> relay_sync ──> downstream work
          └── crash ───────> expiry ──> new model relay_sync
```

The deterministic OpenAI-compatible worker calls sync before the first model
turn. If the model exits without completing, failing, or handing off its
leased task, the wrapper performs a safe handoff with the last model output as
the recovery checkpoint. After a terminal task action, it waits without a
model call, claims newly unlocked work, and continues until the mission ends.

## Default council workflow

```text
primary solution ────────┐
failure-mode challenge ──┼──> cross-examination ──> synthesis ──> result
evidence and tests ──────┘            │
           └──────────────────────────┘
```

The contribution tasks have reserved model seats, preventing one session from
monopolizing the council. An absent seat becomes claimable after a bounded
reservation; recovery clears a crashed seat immediately. Cross-examination
cannot be leased until every contribution completes. Synthesis cannot be
leased until cross-examination also completes, then receives every structured
result, latest checkpoint, and task artifact in one sync envelope.

## Portable capsule

```text
mission snapshot + decision trail + signed events
                       │ canonical JSON + SHA-256
                       ▼
            Ed25519-sealed context capsule
                       │
        Claude · ChatGPT · DeepSeek · future model
```

The capsule is a read-only context transfer artifact, not a credential or a
task lease. Its signature can be verified independently by the TypeScript SDK.

## State machines

Mission:

`draft -> active <-> paused -> completed | failed | cancelled`

Task:

`queued -> leased -> running -> completed | failed | cancelled`

Lease expiry requeues recoverable work. A planned handoff also returns the task
to `queued`, but does not consume a failure attempt. Every new lease increments
the task's fencing token, so stale writes cannot win a race after recovery.

## Persistence and restart

SQLite runs in WAL mode with foreign keys and a busy timeout. Connection
tickets store the last RelayMesh session ID. After a full RelayMesh process
restart, reconnecting with the same ticket reuses an active session or creates
a recovery session from a lost or gracefully left predecessor. The latest
checkpoint and task remain provider-independent.

The current storage engine is single-node. The public protocol keeps the store
behind a service boundary so a future PostgreSQL or distributed-log adapter
does not change model clients.

## Provider boundary

The coordination core never calls Claude, ChatGPT, DeepSeek, Gemini, or any
other model API. MCP, A2A, OpenAI-compatible functions, and REST translate
provider behavior into the same eleven operations. Provider names, context
formats, and conversation IDs are metadata, not ownership state.
