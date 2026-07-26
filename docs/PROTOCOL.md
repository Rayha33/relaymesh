# RelayMesh coordination protocol v2

RelayMesh separates durable coordination from model conversation. REST, local
and remote MCP, A2A v1.0 HTTP+JSON, and OpenAI-compatible function tools all
operate on the same missions, task leases, checkpoints, messages, artifacts,
and signed events.

## Canonical sync envelope

Every model starts and reconnects through one operation:

- REST: `POST /api/v1/sessions/:sessionId/sync`
- MCP or function calling: `relay_sync`
- A2A: `POST /a2a/v1/message:send`

The result uses `protocol: "relaymesh/2"` and includes:

- the mission and current session;
- active peer sessions and their liveness;
- renewed heartbeat deadline;
- either the already-owned lease or one newly claimed compatible task;
- the latest recovery checkpoint;
- completed direct dependency outputs, checkpoints, and artifacts for the
  claimed task;
- unacknowledged durable inbox messages;
- mission artifacts and current event sequence;
- canonical next-step instructions.

Sync is idempotent. Repeating it does not claim a second task or increment the
task attempt again.

After completing, failing, or handing off a task, an agent syncs again. This
allows the same session to claim newly unlocked downstream work and prevents a
multi-stage mission from being abandoned between tasks.

## Productivity workflow and final result

`relaymesh launch` defaults to a fan-out/fan-in workflow when several models
are supplied. Each model can claim a distinct independent contribution. A
final synthesis task depends on every contribution and receives their outputs
through `dependencyOutputs`; no provider chat transcript is required.

The final result is available through:

- REST: `GET /api/v1/missions/:missionId/result`
- CLI: `relaymesh mission:result --mission <mission-id>`

The report is ready only when the mission is completed and every leaf task has
a non-empty structured result or artifact. It includes final outputs,
completion progress, contributor count, handoffs, recoveries, checkpoints,
messages, blockers, artifacts, elapsed time, and event-chain verification.

## Atomic handoff

`POST /api/v1/tasks/:taskId/handoff`, `relay_handoff`, or the SDK handoff method
commits one transaction that:

1. writes a model-independent checkpoint;
2. releases the current lease;
3. fences the old writer;
4. requeues the task for the target role;
5. sends a durable `handoff` message.

A planned handoff does not consume the task's failure budget. The receiving
model calls sync and gets the checkpoint, new lease, new fencing token, and
handoff message together.

## Transport adapters

- Local MCP: `relaymesh-mcp` over stdio.
- Remote MCP: `/mcp/:missionId/:agentId?...` over Streamable HTTP with the
  agent key as a Bearer token.
- Scoped remote MCP: `/mcp/connect/:ticket` for clients that cannot configure
  a separate secret. The URL is itself a credential.
- A2A v1.0: public discovery at `/.well-known/agent-card.json`; authenticated
  HTTP+JSON interface at `/a2a/v1`.
- OpenAI-compatible functions:
  `GET /.well-known/relaymesh-tools.json`.
- Native REST: `/api/v1`.

Connection tickets are hashed at rest, bound to one mission, agent, model,
role, and capability set, independently revocable, and limited to 30 days.
The ticket's most recent durable RelayMesh session ID is persisted in SQLite.
No adapter depends on process-local connection memory for recovery.

## Authentication

Administrators use:

```http
Authorization: Bearer <admin-token>
```

REST sessions use an Ed25519-signed, mission-scoped session JWT:

```http
Authorization: Bearer <session-token>
```

Remote MCP validates an agent key or scoped ticket on every request. A2A
validates a scoped ticket on every request and also requires:

```http
A2A-Version: 1.0
Authorization: Bearer <scoped-ticket>
Content-Type: application/a2a+json
```

## Idempotency

Mutating REST requests accept:

```http
Idempotency-Key: <client-generated-unique-key>
```

Repeated keys return the original result. A key cannot be reused for a
different operation.

## Leasing and crash recovery

Claims return a lease ID and a monotonically increasing fencing token. Every
checkpoint, handoff, completion, and failure is checked against the active
lease. A late response from a crashed or handed-off session is rejected.

When a heartbeat expires, recovery:

1. marks the old session lost;
2. expires its active leases;
3. requeues recoverable tasks;
4. retains the latest checkpoint;
5. increments the fence on the next claim.

This provides at-least-once work delivery. External side effects still require
connector-specific idempotency.

## Durable messages and artifacts

Messages use the intents `inform`, `request`, `response`, `challenge`,
`decision`, `handoff`, and `blocker`. They can target a session, role, or
mission broadcast. Unacknowledged messages remain replayable.

Artifacts are immutable, content-addressed blobs. Checkpoints and messages
reference artifact IDs instead of mutable provider attachments.

## RelayMesh A2A extension v1

RelayMesh implements A2A v1.0 HTTP+JSON discovery, message send, task get/list,
and task cancellation. Native A2A task IDs and context IDs map directly to
RelayMesh task IDs and mission IDs.

The optional extension URI advertised in the Agent Card adds a
`relaymesh-sync-envelope.json` artifact to an A2A task returned from
`message:send`. Its data is the canonical `relaymesh/2` envelope described
above. Clients that ignore the extension still receive standard A2A task
status, messages, artifacts, and metadata.

RelayMesh does not advertise streaming or push notifications. Unsupported A2A
versions and other errors use the A2A v1.0 `google.rpc.Status` error shape.

## Signed events

Every accepted state mutation appends a per-mission event containing its
sequence, actor, type, canonical payload, previous hash, current hash, Ed25519
signature, and timestamp. `relaymesh verify --mission <id>` independently
checks the chain.
