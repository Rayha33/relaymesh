# RelayMesh

**The durable coordination plane between Claude, ChatGPT, DeepSeek, Codex,
Gemini, local models, and future AI agents.**

Models do not need to share a provider, context window, conversation format, or
even cooperate correctly. RelayMesh gives every session one authoritative sync
envelope and enforces ownership, recovery, and handoff outside the model.

It is not another multi-model chat window. It is the runtime underneath them.

```text
Claude checkpoints ──> atomic handoff ──> DeepSeek receives the same task
       │                                      + checkpoint + inbox + new fence
       └── crashes ──> lease expires ────────> ChatGPT safely resumes
```

## What changed in v0.4

v0.4 makes multi-model work productive by default, not merely connected:

- **Parallel contribution tracks:** one launch creates distinct solution,
  challenge, and verification work instead of making several models compete
  for one task.
- **Automatic context assembly:** the final synthesis task receives every
  completed dependency result, checkpoint, and artifact in its `relay_sync`
  envelope.
- **Continuous guarded workers:** OpenAI-compatible workers wait without model
  token spend, claim newly unlocked downstream work, and continue until the
  mission is terminal.
- **One durable deliverable:** `relaymesh mission:result` and the dashboard
  expose the final self-contained result without requiring anyone to read
  provider chat histories.
- **Measurable productivity:** each result reports progress, distinct
  contributors, handoffs, recoveries, checkpoints, blockers, artifacts,
  elapsed time, and signed-event integrity.
- **Crash-safe coordination:** leases, fencing, checkpoints, atomic handoff,
  restart-proof scoped connections, MCP, A2A v1.0, and REST remain enforced by
  the provider-neutral runtime.

## Why this is hard to replace

The durable core is provider-independent and accumulates the coordination
history that chat clients discard:

| Failure | Runtime guarantee |
| --- | --- |
| Two models take the same work | Exclusive expiring lease |
| Old model replies after recovery | Monotonic fencing token rejects it |
| Provider or process crashes | Checkpointed task is requeued |
| Model quits without handing off | Worker wrapper performs safe handoff |
| Models see different context | Canonical `relaymesh/2` sync envelope |
| Provider changes | Mission state contains no provider-specific ownership |
| Request result is uncertain | Idempotency key returns the original result |
| Output or history is disputed | Content hashes and signed event chain |

## Quick start

Requires Node.js 24 or newer.

```bash
npm install --global github:Rayha33/relaymesh
mkdir relaymesh-workspace && cd relaymesh-workspace
relaymesh start
```

In a second terminal:

```bash
relaymesh launch \
  --objective "Research, implement, and independently verify the result" \
  --models claude,chatgpt,deepseek
```

By default, three models receive three independent contribution tracks. The
final synthesis task unlocks only after those tracks finish and automatically
receives their durable outputs. The JSON result contains each model's scoped
connection, startup prompt, the planned tasks, and a `resultCommand`. Give
each client its matching connection and startup prompt. Treat the output as
credentials.

Read the finished deliverable at any time:

```bash
relaymesh mission:result --mission <mission-id>
```

Use `--workflow single` when parallel review would add no value.

Open [http://127.0.0.1:4317](http://127.0.0.1:4317) for the operator
dashboard. `relaymesh token` prints the local administrator token.

For a pre-seeded visual demo:

```bash
relaymesh demo
```

Developer checkout:

```bash
git clone https://github.com/Rayha33/relaymesh.git
cd relaymesh
npm install
npm run check
npm run demo
```

## Connect any model

All adapters reach the same state machine.

| Client | Adapter |
| --- | --- |
| Claude Desktop / Claude Code | stdio MCP |
| Codex and local MCP clients | stdio MCP |
| ChatGPT personal connection | Scoped Streamable HTTP MCP URL |
| OpenAI Responses API | Bearer-authenticated Streamable HTTP MCP |
| DeepSeek / OpenAI-compatible API | Strict function tools + included worker |
| A2A v1.0 agents | Agent Card + authenticated HTTP+JSON |
| Custom Python, Go, Rust, Java | REST protocol |

Generate connection settings for an existing mission and agent:

```bash
relaymesh connect \
  --mission <mission-id> \
  --agent <agent-id> \
  --model <model-name> \
  --role worker \
  --capabilities general
```

Create a revocable connection ticket for clients that need a scoped credential:

```bash
relaymesh connect:create \
  --mission <mission-id> \
  --agent <agent-id> \
  --model chatgpt \
  --role worker \
  --capabilities general \
  --ttl-hours 24
```

The returned MCP URL and A2A Bearer value are restricted to one mission,
agent, model, role, capability set, and expiry. Revoke them with:

```bash
relaymesh connect:revoke --connection <connection-id>
```

### MCP

The local executable is `relaymesh-mcp`. Ready-to-edit configurations:

- [Claude Desktop](examples/mcp/claude-desktop.example.json)
- [Codex](examples/mcp/codex.example.toml)

Remote Streamable HTTP MCP is available at:

```text
/mcp/<mission-id>/<agent-id>?model=<model>&role=<role>&capabilities=general
/mcp/connect/<scoped-ticket>
```

Every model receives the same eleven tools:

- `relay_sync`
- `relay_status`
- `relay_claim_task`
- `relay_checkpoint`
- `relay_handoff`
- `relay_complete_task`
- `relay_fail_task`
- `relay_send_message`
- `relay_inbox`
- `relay_acknowledge`
- `relay_publish_artifact`

The required lifecycle is: sync, work, checkpoint, complete, fail, or hand
off, then sync again. A continuing session can claim an unlocked downstream
task; it stops only when the mission is terminal. The remote adapter validates
credentials on every request.

OpenAI Responses API example:

```ts
const response = await openai.responses.create({
  model: process.env.OPENAI_MODEL!,
  tools: [{
    type: "mcp",
    server_label: "relaymesh",
    server_url: process.env.RELAYMESH_MCP_URL!,
    authorization: process.env.RELAYMESH_AGENT_KEY!,
    require_approval: "never",
  }],
  input: "Call relay_sync, obey its current work fence, and continue.",
});
```

Hosted clients need HTTPS. Use a trusted private tunnel or hardened reverse
proxy. A public multi-user ChatGPT integration still requires per-user OAuth
and authorization.

### A2A v1.0

Discovery:

```text
GET /.well-known/agent-card.json
```

The Agent Card advertises the HTTP+JSON interface at `/a2a/v1`. Authenticated
requests require:

```http
A2A-Version: 1.0
Authorization: Bearer <scoped-ticket>
Content-Type: application/a2a+json
```

Implemented methods:

```text
POST /a2a/v1/message:send
GET  /a2a/v1/tasks
GET  /a2a/v1/tasks/<task-id>
POST /a2a/v1/tasks/<task-id>:cancel
```

`message:send` persists the incoming message, synchronizes the agent, and
returns either an A2A Task containing the canonical RelayMesh sync-envelope
artifact or an A2A Message when no compatible work is ready.

### DeepSeek and OpenAI-compatible models

Strict function schemas are published at
`/.well-known/relaymesh-tools.json`. The included worker injects each
authoritative sync envelope, safely hands leased work back if the model stops
without a terminal action, and waits for downstream dependencies without
spending model tokens:

```bash
MODEL_API_BASE=https://api.deepseek.com \
MODEL_API_KEY="$DEEPSEEK_API_KEY" \
MODEL_NAME=<deepseek-model> \
RELAYMESH_MISSION_ID=<mission-id> \
RELAYMESH_AGENT_ID=<agent-id> \
RELAYMESH_AGENT_KEY=<agent-key> \
relaymesh worker:openai
```

Change only `MODEL_API_BASE` and `MODEL_NAME` for another compatible provider.

### TypeScript SDK

```ts
import { RelayAgentClient } from "relaymesh";

const agent = new RelayAgentClient(agentId, agentKey);
const { session } = await agent.join(missionId, {
  model: "claude-or-gpt-or-anything",
  role: "worker",
  capabilities: ["general"],
  recoveryFromSessionId: null,
});

const state = await session.sync();
if (state.work) {
  await session.handoff(state.work.task.id, {
    leaseId: state.work.lease.id,
    fencingToken: state.work.lease.fencingToken,
    summary: "Durable work completed so far.",
    nextAction: "Independently verify it.",
    decisions: [],
    artifactIds: [],
    opaqueState: null,
    targetRole: "reviewer",
    subject: "Ready for review",
    content: "Resume from the checkpoint.",
    priority: 10,
  });
}
```

## Guarantees and limits

RelayMesh provides at-least-once work delivery. A runtime cannot generally know
whether an external side effect happened just before a model crashed. Use
connector-specific idempotency for external writes.

RelayMesh does guarantee that an expired or handed-off lease cannot later
complete the task with its stale fence.

v0.4 is a single-node SQLite runtime. It binds to `127.0.0.1`, hashes static
credentials, signs mission events with Ed25519, validates schemas, rate-limits
requests, and never executes model-supplied shell commands. Do not expose it
directly to the public internet.

Read:

- [Coordination protocol](docs/PROTOCOL.md)
- [Architecture and state machines](docs/ARCHITECTURE.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Security policy](SECURITY.md)

## Operations

| Command | Purpose |
| --- | --- |
| `relaymesh start` | Start the installed production runtime |
| `relaymesh launch ...` | Create a mission and multi-model connection bundle |
| `relaymesh mission:result --mission ID` | Read the durable final output and productivity report |
| `relaymesh demo` | Seed and run the visual demo |
| `relaymesh-mcp` | Start the local MCP bridge |
| `relaymesh connect:create ...` | Issue scoped MCP and A2A credentials |
| `relaymesh connect:revoke ...` | Revoke a connection immediately |
| `relaymesh worker:openai` | Run the guarded OpenAI-compatible worker |
| `npm run check` | Typecheck, lint, test, and build |
| `npm run test:coverage` | Run coverage gates |
| `npm run test:package` | Verify the packed consumer install and audit |

Environment options are in [.env.example](.env.example).

## Scope after v0.4

Next layers are a PostgreSQL event-store adapter, Python SDK, OAuth/team
identity, policy-as-code, encrypted remote relay, external-action connectors,
and OpenTelemetry. The provider-neutral mission and sync protocol do not need
to change when those arrive.

RelayMesh is MIT licensed. Contributions are welcome; see
[CONTRIBUTING.md](CONTRIBUTING.md).
