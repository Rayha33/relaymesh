import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type {
  HeartbeatResult,
  JoinedSession,
} from "../core/runtime.js";
import type {
  CheckpointInput,
  CompleteTaskInput,
  CreateArtifactInput,
  FailTaskInput,
  SendMessageInput,
} from "../core/schemas.js";
import type {
  Artifact,
  Checkpoint,
  ClaimResult,
  RelayMessage,
  Task,
} from "../core/types.js";
import { RelayApiError } from "../sdk/client.js";

const outputSchema = { data: z.unknown() };
const closedWorld = { openWorldHint: false };

export interface RelayMcpSession {
  heartbeat(): Promise<HeartbeatResult>;
  claim(): Promise<ClaimResult | null>;
  checkpoint(taskId: string, input: CheckpointInput): Promise<Checkpoint>;
  complete(taskId: string, input: CompleteTaskInput): Promise<Task>;
  fail(taskId: string, input: FailTaskInput): Promise<Task>;
  sendMessage(input: SendMessageInput): Promise<RelayMessage>;
  inbox(includeAcknowledged?: boolean): Promise<RelayMessage[]>;
  acknowledge(messageId: string): Promise<RelayMessage>;
  publishArtifact(input: CreateArtifactInput): Promise<Artifact>;
}

export function createRelayMcpServer(
  session: RelayMcpSession,
  joined: JoinedSession,
): McpServer {
  const server = new McpServer(
    {
      name: "relaymesh",
      version: "0.2.0",
    },
    {
      instructions: [
        "RelayMesh is the canonical coordination state for this mission.",
        "Start with relay_status and relay_inbox, then claim only work returned by relay_claim_task.",
        "Checkpoint after meaningful progress and before external side effects.",
        "Use typed messages for requests, challenges, decisions, handoffs, and blockers.",
        "Complete or fail leased work with the exact lease ID and fencing token.",
        "Never reuse a stale lease after a crash or reconnect.",
      ].join(" "),
    },
  );

  server.registerTool(
    "relay_status",
    {
      title: "Read mission status and renew this session",
      description:
        "Call first and periodically. Renews the current agent session and returns its durable mission identity and unread-message count.",
      outputSchema,
      annotations: {
        ...closedWorld,
        readOnlyHint: false,
        destructiveHint: false,
      },
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
        "Lease the highest-priority ready task matching this session's role and capabilities. Returns the latest recovery checkpoint when one exists.",
      outputSchema,
      annotations: {
        ...closedWorld,
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    async () => result(await session.claim()),
  );

  server.registerTool(
    "relay_checkpoint",
    {
      title: "Checkpoint recoverable task progress",
      description:
        "Persist provider-neutral recovery state after meaningful progress and before risky or external work.",
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
      outputSchema,
      annotations: {
        ...closedWorld,
        readOnlyHint: false,
        destructiveHint: false,
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
        "Commit a task result using the active lease and fencing token. RelayMesh rejects late writes from crashed or superseded sessions.",
      inputSchema: {
        taskId: z.string().uuid(),
        leaseId: z.string().uuid(),
        fencingToken: z.number().int().positive(),
        resultJson: z.string().default("{}"),
      },
      outputSchema,
      annotations: {
        ...closedWorld,
        readOnlyHint: false,
        destructiveHint: false,
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
      title: "Report or release failed work",
      description:
        "Report a blocker or failure. Retryable work returns to the queue while attempts remain; terminal failure may fail the mission.",
      inputSchema: {
        taskId: z.string().uuid(),
        leaseId: z.string().uuid(),
        fencingToken: z.number().int().positive(),
        reason: z.string().min(1),
        retryable: z.boolean().default(true),
      },
      outputSchema,
      annotations: {
        ...closedWorld,
        readOnlyHint: false,
        destructiveHint: true,
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
      title: "Send a durable message to other agents",
      description:
        "Send a typed, replayable message to one session, a role, or every agent in this mission.",
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
      outputSchema,
      annotations: {
        ...closedWorld,
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    async (input) => safeResult(async () => session.sendMessage(input)),
  );

  server.registerTool(
    "relay_inbox",
    {
      title: "Read the durable agent inbox",
      description:
        "Read replayable messages addressed to this session, its role, or the whole mission.",
      inputSchema: {
        includeAcknowledged: z.boolean().default(false),
      },
      outputSchema,
      annotations: {
        ...closedWorld,
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async ({ includeAcknowledged }) =>
      safeResult(async () => session.inbox(includeAcknowledged)),
  );

  server.registerTool(
    "relay_acknowledge",
    {
      title: "Acknowledge a processed message",
      description:
        "Mark one inbox message as processed. It remains replayable until this acknowledgement succeeds.",
      inputSchema: { messageId: z.string().uuid() },
      outputSchema,
      annotations: {
        ...closedWorld,
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    async ({ messageId }) =>
      safeResult(async () => session.acknowledge(messageId)),
  );

  server.registerTool(
    "relay_publish_artifact",
    {
      title: "Publish an immutable mission artifact",
      description:
        "Persist content for other model sessions and identify it by a content-addressed SHA-256 hash.",
      inputSchema: {
        taskId: z.string().uuid().nullable().default(null),
        name: z.string().min(1),
        mimeType: z.string().min(1),
        contentBase64: z.string().min(1),
        metadataJson: z.string().default("{}"),
      },
      outputSchema,
      annotations: {
        ...closedWorld,
        readOnlyHint: false,
        destructiveHint: false,
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
              "1. Call relay_status when starting or reconnecting.",
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

  return server;
}

function result(value: unknown) {
  return {
    structuredContent: { data: value },
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
      structuredContent: { data: { error: message } },
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
