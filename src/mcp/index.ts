#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import { RelayAgentClient, RelayApiError } from "../sdk/client.js";

const config = {
  baseUrl: requiredEnv("RELAYMESH_URL", "http://127.0.0.1:4317"),
  missionId: requiredEnv("RELAYMESH_MISSION_ID"),
  agentId: requiredEnv("RELAYMESH_AGENT_ID"),
  agentKey: requiredEnv("RELAYMESH_AGENT_KEY"),
  model: requiredEnv("RELAYMESH_MODEL", "unknown"),
  role: requiredEnv("RELAYMESH_ROLE", "worker"),
  capabilities: requiredEnv("RELAYMESH_CAPABILITIES", "general")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
};

const agent = new RelayAgentClient(config.agentId, config.agentKey, {
  baseUrl: config.baseUrl,
});
const { joined, session } = await agent.join(config.missionId, {
  model: config.model,
  role: config.role,
  capabilities: config.capabilities,
  recoveryFromSessionId: process.env.RELAYMESH_RECOVERY_SESSION_ID ?? null,
});

const server = new McpServer({
  name: "relaymesh",
  version: "0.1.0",
});

server.registerTool(
  "relay_status",
  {
    title: "RelayMesh status",
    description:
      "Heartbeat this agent session and return durable mission state plus unread-message count.",
  },
  async () =>
    result({
      session: joined.session,
      mission: joined.snapshot.mission,
      heartbeat: await session.heartbeat(),
    }),
);

server.registerTool(
  "relay_claim_task",
  {
    title: "Claim the next compatible task",
    description:
      "Lease the highest-priority queued task matching this agent's role and capabilities. Returns the last recovery checkpoint when present.",
  },
  async () => result(await session.claim()),
);

server.registerTool(
  "relay_checkpoint",
  {
    title: "Checkpoint task work",
    description:
      "Persist model-independent recovery state before risky work or whenever meaningful progress is made.",
    inputSchema: {
      taskId: z.string().uuid(),
      leaseId: z.string().uuid(),
      fencingToken: z.number().int().positive(),
      summary: z.string().min(1),
      nextAction: z.string().default(""),
      decisionsJson: z
        .string()
        .default("[]")
        .describe("JSON array of {decision, rationale?} objects"),
      artifactIds: z.array(z.string().uuid()).default([]),
      opaqueStateJson: z
        .string()
        .default("{}")
        .describe("Optional JSON object for model-specific state"),
    },
  },
  async ({
    taskId,
    leaseId,
    fencingToken,
    summary,
    nextAction,
    decisionsJson,
    artifactIds,
    opaqueStateJson,
  }) =>
    safeResult(async () =>
      session.checkpoint(taskId, {
        leaseId,
        fencingToken,
        summary,
        nextAction,
        decisions: parseJson(decisionsJson, []),
        artifactIds,
        opaqueState: parseJson(opaqueStateJson, {}),
      }),
    ),
);

server.registerTool(
  "relay_complete_task",
  {
    title: "Complete a leased task",
    description:
      "Complete work only with the active lease and fencing token. Late writes from crashed sessions are rejected.",
    inputSchema: {
      taskId: z.string().uuid(),
      leaseId: z.string().uuid(),
      fencingToken: z.number().int().positive(),
      resultJson: z.string().default("{}"),
    },
  },
  async ({ taskId, leaseId, fencingToken, resultJson }) =>
    safeResult(async () =>
      session.complete(taskId, {
        leaseId,
        fencingToken,
        result: parseJson(resultJson, {}),
      }),
    ),
);

server.registerTool(
  "relay_fail_task",
  {
    title: "Release or fail a task",
    description:
      "Report a blocker or failure. Retryable failures return the task to the queue while attempts remain.",
    inputSchema: {
      taskId: z.string().uuid(),
      leaseId: z.string().uuid(),
      fencingToken: z.number().int().positive(),
      reason: z.string().min(1),
      retryable: z.boolean().default(true),
    },
  },
  async ({ taskId, leaseId, fencingToken, reason, retryable }) =>
    safeResult(async () =>
      session.fail(taskId, {
        leaseId,
        fencingToken,
        reason,
        retryable,
      }),
    ),
);

server.registerTool(
  "relay_send_message",
  {
    title: "Send a durable agent message",
    description:
      "Send a typed message to one session, a role, or every agent in the mission.",
    inputSchema: {
      toSessionId: z.string().uuid().nullable().default(null),
      toRole: z.string().nullable().default(null),
      intent: z.enum([
        "inform",
        "request",
        "response",
        "challenge",
        "decision",
        "handoff",
        "blocker",
      ]),
      subject: z.string().min(1),
      content: z.string().min(1),
      priority: z.number().int().min(-100).max(100).default(0),
      correlationId: z.string().uuid().nullable().default(null),
      replyToId: z.string().uuid().nullable().default(null),
      artifactIds: z.array(z.string().uuid()).default([]),
    },
  },
  async (input) => safeResult(async () => session.sendMessage(input)),
);

server.registerTool(
  "relay_inbox",
  {
    title: "Read the durable agent inbox",
    description:
      "Return replayable messages addressed to this session, role, or mission.",
    inputSchema: {
      includeAcknowledged: z.boolean().default(false),
    },
  },
  async ({ includeAcknowledged }) =>
    safeResult(async () => session.inbox(includeAcknowledged)),
);

server.registerTool(
  "relay_acknowledge",
  {
    title: "Acknowledge a message",
    description:
      "Mark one inbox message as processed. Delivery remains at-least-once until acknowledged.",
    inputSchema: { messageId: z.string().uuid() },
  },
  async ({ messageId }) =>
    safeResult(async () => session.acknowledge(messageId)),
);

server.registerTool(
  "relay_publish_artifact",
  {
    title: "Publish a content-addressed artifact",
    description:
      "Persist an artifact for other model sessions and reference it by immutable hash.",
    inputSchema: {
      taskId: z.string().uuid().nullable().default(null),
      name: z.string().min(1),
      mimeType: z.string().min(1),
      contentBase64: z.string().min(1),
      metadataJson: z.string().default("{}"),
    },
  },
  async ({ taskId, name, mimeType, contentBase64, metadataJson }) =>
    safeResult(async () =>
      session.publishArtifact({
        taskId,
        name,
        mimeType,
        contentBase64,
        metadata: parseJson(metadataJson, {}),
      }),
    ),
);

server.registerPrompt(
  "relaymesh_agent_protocol",
  {
    title: "RelayMesh cooperation protocol",
    description:
      "Operating instructions for a cooperative, crash-recoverable AI agent session.",
  },
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "You are participating in a RelayMesh mission.",
            "1. Call relay_status when starting.",
            "2. Read and acknowledge relevant inbox messages.",
            "3. Claim only a task returned by relay_claim_task.",
            "4. Checkpoint after each meaningful decision and before external side effects.",
            "5. Treat checkpoints and artifacts as canonical; do not rely on hidden chat context.",
            "6. Send typed messages when requesting help, challenging a claim, handing off, or reporting a blocker.",
            "7. Complete or fail every leased task with its exact lease ID and fencing token.",
            "8. Never reuse a stale lease after a crash or recovery.",
          ].join("\n"),
        },
      },
    ],
  }),
);

const heartbeatTimer = setInterval(() => {
  void session.heartbeat().catch((error: unknown) => {
    process.stderr.write(
      `RelayMesh heartbeat failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  });
}, 10_000);
heartbeatTimer.unref();

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  `RelayMesh MCP joined mission ${config.missionId} as session ${joined.session.id}\n`,
);

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

async function safeResult(fn: () => Promise<unknown>) {
  try {
    return result(await fn());
  } catch (error) {
    const message =
      error instanceof RelayApiError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      isError: true,
      content: [{ type: "text" as const, text: message }],
    };
  }
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function requiredEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value.length === 0) {
    process.stderr.write(`Missing required environment variable ${name}\n`);
    process.exit(1);
  }
  return value;
}
