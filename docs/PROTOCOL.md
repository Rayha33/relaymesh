# RelayMesh coordination protocol v1

The HTTP API is the reference protocol. The TypeScript SDK and MCP bridge are
adapters over the same operations.

## Authentication

Administrators use:

```http
Authorization: Bearer <admin-token>
```

Agent sessions use:

```http
Authorization: Bearer <session-token>
```

Session tokens are signed Ed25519 JWTs, scoped to one agent identity, session,
mission, and role. Tokens expire and are revocable.

## Idempotency

Mutating agent requests accept:

```http
Idempotency-Key: <client-generated-unique-key>
```

Repeated keys return the original response. A key cannot be reused for a
different operation.

## Join

`POST /api/v1/missions/:missionId/sessions`

An agent identity joins a mission with a model descriptor, role, capabilities,
and optional recovery target. The response includes the session token and
current mission snapshot.

## Heartbeat

`POST /api/v1/sessions/:sessionId/heartbeat`

Refreshes session liveness and active leases. The server returns pending inbox
count and the next heartbeat deadline.

## Claim

`POST /api/v1/missions/:missionId/tasks/claim`

Claims the highest-priority queued task whose requirements are satisfied by the
session. The result includes a lease ID, fencing token, expiration, dependencies,
and latest checkpoint.

## Checkpoint

`POST /api/v1/tasks/:taskId/checkpoints`

Stores a compact recovery capsule:

- summary of completed work;
- decisions and rejected alternatives;
- next action;
- artifact references;
- model-independent state;
- optional opaque model state.

## Messaging

`POST /api/v1/missions/:missionId/messages`

Messages include intent, recipient selector, correlation ID, reply-to ID,
priority, content, and artifact references. Recipients acknowledge messages
individually. Unacknowledged messages remain replayable.

## Completion

`POST /api/v1/tasks/:taskId/complete`

Requires the active lease ID and fencing token. RelayMesh rejects stale
completions after recovery has re-leased the task.

## Events

Every accepted mutation emits an immutable event with:

- sequence number;
- mission ID;
- actor;
- event type;
- canonical payload;
- previous hash;
- current hash;
- Ed25519 signature.

This makes coordination history independently verifiable.
