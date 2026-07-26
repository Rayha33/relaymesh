# RelayMesh

**Durable coordination for AI agent sessions that do not naturally cooperate.**

RelayMesh gives Claude, Codex, Gemini, local models, and custom agents one
model-independent place to coordinate work. A mission survives closed terminals,
expired context windows, provider switches, network failures, and crashed agent
processes.

It is not another multi-model chat window. It is the runtime underneath them.

```text
Agent A crashes ──> lease expires ──> task is fenced ──> checkpoint is loaded
                                                        │
Agent B joins  <────────────────────────────────────────┘
```

## Why this exists

Multi-agent work commonly fails because:

- chat history is mistaken for shared state;
- two models silently work on the same task;
- agents cannot address or challenge each other reliably;
- a crashed session takes its decisions and progress with it;
- the late response from a recovered session overwrites newer work;
- outputs are pasted between tools without provenance.

RelayMesh turns these failure modes into explicit protocol behavior:

| Failure | RelayMesh primitive |
| --- | --- |
| Session disappears | Heartbeats and automatic loss detection |
| Duplicate work | Exclusive, expiring task leases |
| Late write after recovery | Monotonic fencing tokens |
| Context/model switch | Model-independent checkpoints |
| Agents do not cooperate | Typed, durable inbox messages |
| Mutable outputs | Content-addressed artifacts |
| Retry after timeout | Idempotency keys |
| Disputed history | Signed, hash-chained event log |

## Five-minute demo

Requirements: Node.js 24 or newer.

```bash
git clone https://github.com/Rayha33/relaymesh.git
cd relaymesh
npm install
npm run demo
```

Open [http://localhost:5173](http://localhost:5173), then get the local
administrator token:

```bash
npm run cli -- token
```

`npm run demo` creates a mission with Codex-, Claude-, and Gemini-shaped agent
identities plus a dependency-aware task graph. The generated agent keys are
stored with mode `0600` in `data/demo-credentials.json`.

For a clean non-demo runtime:

```bash
npm install
npm run build
npm start
```

The production server hosts the dashboard and API at
[http://127.0.0.1:4317](http://127.0.0.1:4317).

## Connect an AI model

### MCP bridge

RelayMesh ships an MCP server so an existing AI client can join a mission
without learning a proprietary API.

Set these variables when launching `npm run mcp`:

```bash
RELAYMESH_URL=http://127.0.0.1:4317
RELAYMESH_MISSION_ID=<mission-id>
RELAYMESH_AGENT_ID=<agent-id>
RELAYMESH_AGENT_KEY=<agent-key>
RELAYMESH_MODEL=<model-name>
RELAYMESH_ROLE=builder
RELAYMESH_CAPABILITIES=code.typescript,test.unit
```

Ready-to-edit examples:

- [Claude Desktop configuration](examples/mcp/claude-desktop.example.json)
- [Codex configuration](examples/mcp/codex.example.toml)

The bridge exposes:

- `relay_status`
- `relay_claim_task`
- `relay_checkpoint`
- `relay_complete_task`
- `relay_fail_task`
- `relay_send_message`
- `relay_inbox`
- `relay_acknowledge`
- `relay_publish_artifact`

It also exposes the `relaymesh_agent_protocol` prompt, which teaches a model the
cooperation and recovery rules.

### TypeScript SDK

```ts
import { RelayAgentClient } from "./src/sdk/index.js";

const agent = new RelayAgentClient(agentId, agentKey);
const { session } = await agent.join(missionId, {
  model: "any-model",
  role: "builder",
  capabilities: ["code.typescript"],
  recoveryFromSessionId: null,
});

const claim = await session.claim();
if (claim) {
  await session.checkpoint(claim.task.id, {
    leaseId: claim.lease.id,
    fencingToken: claim.lease.fencingToken,
    summary: "Implemented the event store.",
    nextAction: "Run the recovery tests.",
    decisions: [],
    artifactIds: [],
    opaqueState: null,
  });
}
```

See [examples/worker.ts](examples/worker.ts) for a runnable worker.

## What recovery guarantees

RelayMesh deliberately provides **at-least-once delivery**, not a false
exactly-once promise.

If an agent performs an external side effect and crashes before reporting it,
no general runtime can know whether that side effect happened. RelayMesh makes
retries safe where possible through:

- client idempotency keys;
- task lease IDs;
- monotonically increasing fencing tokens;
- explicit checkpoints;
- immutable artifact hashes;
- connector-specific idempotency for external actions.

A completion from an expired lease is rejected even when the old process
eventually returns.

## Core concepts

### Mission

The durable owner of an objective, task graph, messages, artifacts, sessions,
and event history.

### Agent identity and session

An agent identity is stable. A session is short-lived, model-specific, scoped
to one mission, and authenticated with an Ed25519-signed JWT.

### Task lease

Compatible sessions claim tasks based on role, capabilities, dependencies, and
priority. Ownership must be renewed by heartbeat.

### Recovery checkpoint

A compact capsule containing completed work, decisions, rejected alternatives,
artifacts, next action, and optional model-specific state.

### Durable message

Messages use explicit intents: `inform`, `request`, `response`, `challenge`,
`decision`, `handoff`, or `blocker`. Delivery is replayable until acknowledged.

## Architecture

```text
Claude / Codex / Gemini / local agents
            │ REST SDK · MCP
            ▼
┌──────────────────────────────┐
│ RelayMesh gateway            │
│ auth · validation · limits   │
├──────────────────────────────┤
│ Coordination runtime         │
│ scheduler · leases · inbox   │
│ checkpoints · recovery       │
├──────────────────────────────┤
│ SQLite WAL + signed events   │
└──────────────┬───────────────┘
               ▼
       Operator dashboard
```

Detailed documents:

- [Architecture and state machines](docs/ARCHITECTURE.md)
- [Coordination protocol](docs/PROTOCOL.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Durable event-log decision](docs/DECISIONS/0001-durable-event-log.md)

## Docker

```bash
docker compose up --build
docker compose exec relaymesh \
  node dist/server/src/cli/index.js token
```

The compose file binds RelayMesh to localhost and persists `/app/data`.

## Operations

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run API and dashboard with live reload |
| `npm run build` | Produce the production server and web bundle |
| `npm start` | Start the production runtime |
| `npm run cli -- token` | Read the locally generated admin token |
| `npm run demo:seed` | Add the heterogeneous-agent demo |
| `npm run mcp` | Start the stdio MCP bridge |
| `npm run check` | Typecheck, lint, test, and production-build |
| `npm run test:coverage` | Run coverage gates |

Environment options are documented in [.env.example](.env.example).

## Security posture

- Binds to `127.0.0.1` by default.
- Stores agent keys only as scrypt hashes.
- Uses short-lived, mission-scoped Ed25519 session tokens.
- Redacts credentials from logs.
- Enforces request schemas and body/rate limits.
- Signs a separate hash chain for every mission.
- Never executes shell commands or fetches arbitrary URLs.

Version `0.1` is intentionally single-node. Do not expose it directly to the
public internet. Read [SECURITY.md](SECURITY.md) and the
[threat model](docs/THREAT_MODEL.md) before remote deployment.

## Current scope

Ready now:

- local durable runtime;
- dashboard;
- TypeScript SDK;
- CLI;
- MCP bridge;
- capability scheduling;
- dependency-aware tasks;
- leases, fencing, checkpoints, inbox, artifacts, and automatic recovery;
- signed event verification;
- one-command heterogeneous-agent demo;
- Docker and CI.

Planned:

- PostgreSQL event-store adapter;
- A2A JSON-RPC transport;
- Python SDK;
- encrypted remote relay;
- pluggable external-action connectors;
- OpenTelemetry traces;
- team identities and policy-as-code.

## Contributing

RelayMesh is MIT licensed. Issues and pull requests are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md).
