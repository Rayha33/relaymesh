import { z } from "zod";
import type { RelaySessionClient } from "./client.js";

type JsonSchema = Record<string, unknown>;

export interface RelayFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    strict: true;
    parameters: JsonSchema;
  };
}

const emptyParameters: JsonSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};

export const relayFunctionTools: RelayFunctionTool[] = [
  tool(
    "relay_status",
    "Renew this agent session and return its durable identity plus unread-message count. Call first and periodically.",
    emptyParameters,
  ),
  tool(
    "relay_claim_task",
    "Lease the highest-priority ready task compatible with this session. Returns the latest recovery checkpoint when present.",
    emptyParameters,
  ),
  tool(
    "relay_checkpoint",
    "Persist provider-neutral recovery state after meaningful progress and before external side effects.",
    objectSchema(
      {
        taskId: stringSchema("Task UUID"),
        leaseId: stringSchema("Active lease UUID"),
        fencingToken: integerSchema("Active fencing token"),
        summary: stringSchema("Completed work and current durable state"),
        nextAction: stringSchema("Exact next action for a recovering model"),
        decisionsJson: stringSchema(
          "JSON array of {decision, rationale?} objects",
        ),
        artifactIds: arraySchema("Artifact UUIDs referenced by this checkpoint"),
        opaqueStateJson: stringSchema(
          "JSON object containing optional provider-specific state",
        ),
      },
      [
        "taskId",
        "leaseId",
        "fencingToken",
        "summary",
        "nextAction",
        "decisionsJson",
        "artifactIds",
        "opaqueStateJson",
      ],
    ),
  ),
  tool(
    "relay_complete_task",
    "Commit a task result with the active lease and fencing token. Stale writes are rejected.",
    objectSchema(
      {
        taskId: stringSchema("Task UUID"),
        leaseId: stringSchema("Active lease UUID"),
        fencingToken: integerSchema("Active fencing token"),
        resultJson: stringSchema("JSON object containing the task result"),
      },
      ["taskId", "leaseId", "fencingToken", "resultJson"],
    ),
  ),
  tool(
    "relay_fail_task",
    "Report a blocker or failed attempt. Retryable work returns to the queue while attempts remain.",
    objectSchema(
      {
        taskId: stringSchema("Task UUID"),
        leaseId: stringSchema("Active lease UUID"),
        fencingToken: integerSchema("Active fencing token"),
        reason: stringSchema("Concrete failure or blocker"),
        retryable: {
          type: "boolean",
          description: "Whether another model session should retry the task",
        },
      },
      ["taskId", "leaseId", "fencingToken", "reason", "retryable"],
    ),
  ),
  tool(
    "relay_send_message",
    "Send a typed, durable message to one session, a role, or the entire mission.",
    objectSchema(
      {
        toSessionId: nullableStringSchema("Recipient session UUID or null"),
        toRole: nullableStringSchema("Recipient role or null"),
        intent: {
          type: "string",
          enum: [
            "inform",
            "request",
            "response",
            "challenge",
            "decision",
            "handoff",
            "blocker",
          ],
        },
        subject: stringSchema("Concise message subject"),
        content: stringSchema("Self-contained message body"),
        priority: {
          type: "integer",
          minimum: -100,
          maximum: 100,
        },
        correlationId: nullableStringSchema(
          "Shared correlation UUID for a conversation or null",
        ),
        replyToId: nullableStringSchema("Message UUID being answered or null"),
        artifactIds: arraySchema("Related artifact UUIDs"),
      },
      [
        "toSessionId",
        "toRole",
        "intent",
        "subject",
        "content",
        "priority",
        "correlationId",
        "replyToId",
        "artifactIds",
      ],
    ),
  ),
  tool(
    "relay_inbox",
    "Read replayable messages addressed to this session, role, or mission.",
    objectSchema(
      {
        includeAcknowledged: {
          type: "boolean",
          description: "Include messages this session already acknowledged",
        },
      },
      ["includeAcknowledged"],
    ),
  ),
  tool(
    "relay_acknowledge",
    "Mark one durable inbox message as processed.",
    objectSchema(
      { messageId: stringSchema("Message UUID") },
      ["messageId"],
    ),
  ),
  tool(
    "relay_publish_artifact",
    "Publish immutable base64 content for other model sessions and receive its SHA-256 identity.",
    objectSchema(
      {
        taskId: nullableStringSchema("Related task UUID or null"),
        name: stringSchema("Artifact filename"),
        mimeType: stringSchema("Artifact MIME type"),
        contentBase64: stringSchema("Base64-encoded content"),
        metadataJson: stringSchema("JSON object with optional metadata"),
      },
      ["taskId", "name", "mimeType", "contentBase64", "metadataJson"],
    ),
  ),
];

const checkpointArguments = z.object({
  taskId: z.string().uuid(),
  leaseId: z.string().uuid(),
  fencingToken: z.number().int().positive(),
  summary: z.string().min(1),
  nextAction: z.string(),
  decisionsJson: z.string(),
  artifactIds: z.array(z.string().uuid()),
  opaqueStateJson: z.string(),
});
const completeArguments = z.object({
  taskId: z.string().uuid(),
  leaseId: z.string().uuid(),
  fencingToken: z.number().int().positive(),
  resultJson: z.string(),
});
const failArguments = z.object({
  taskId: z.string().uuid(),
  leaseId: z.string().uuid(),
  fencingToken: z.number().int().positive(),
  reason: z.string().min(1),
  retryable: z.boolean(),
});
const messageArguments = z.object({
  toSessionId: z.string().uuid().nullable(),
  toRole: z.string().min(1).nullable(),
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
  priority: z.number().int().min(-100).max(100),
  correlationId: z.string().uuid().nullable(),
  replyToId: z.string().uuid().nullable(),
  artifactIds: z.array(z.string().uuid()),
});
const inboxArguments = z.object({ includeAcknowledged: z.boolean() });
const acknowledgeArguments = z.object({ messageId: z.string().uuid() });
const artifactArguments = z.object({
  taskId: z.string().uuid().nullable(),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  contentBase64: z.string().min(1),
  metadataJson: z.string(),
});

export async function executeRelayFunction(
  session: RelaySessionClient,
  name: string,
  rawArguments: unknown,
): Promise<unknown> {
  const args = rawArguments ?? {};
  switch (name) {
    case "relay_status":
      return {
        session: session.identity,
        heartbeat: await session.heartbeat(),
      };
    case "relay_claim_task":
      return session.claim();
    case "relay_checkpoint": {
      const input = checkpointArguments.parse(args);
      return session.checkpoint(input.taskId, {
        leaseId: input.leaseId,
        fencingToken: input.fencingToken,
        summary: input.summary,
        nextAction: input.nextAction,
        decisions: parseJson(input.decisionsJson, []),
        artifactIds: input.artifactIds,
        opaqueState: parseJson(input.opaqueStateJson, {}),
      });
    }
    case "relay_complete_task": {
      const input = completeArguments.parse(args);
      return session.complete(input.taskId, {
        leaseId: input.leaseId,
        fencingToken: input.fencingToken,
        result: parseJson(input.resultJson, {}),
      });
    }
    case "relay_fail_task": {
      const input = failArguments.parse(args);
      return session.fail(input.taskId, {
        leaseId: input.leaseId,
        fencingToken: input.fencingToken,
        reason: input.reason,
        retryable: input.retryable,
      });
    }
    case "relay_send_message":
      return session.sendMessage(messageArguments.parse(args));
    case "relay_inbox": {
      const input = inboxArguments.parse(args);
      return session.inbox(input.includeAcknowledged);
    }
    case "relay_acknowledge": {
      const input = acknowledgeArguments.parse(args);
      return session.acknowledge(input.messageId);
    }
    case "relay_publish_artifact": {
      const input = artifactArguments.parse(args);
      return session.publishArtifact({
        taskId: input.taskId,
        name: input.name,
        mimeType: input.mimeType,
        contentBase64: input.contentBase64,
        metadata: parseJson(input.metadataJson, {}),
      });
    }
    default:
      throw new Error(`Unknown RelayMesh function tool: ${name}`);
  }
}

function tool(
  name: string,
  description: string,
  parameters: JsonSchema,
): RelayFunctionTool {
  return {
    type: "function",
    function: { name, description, strict: true, parameters },
  };
}

function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[],
): JsonSchema {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function stringSchema(description: string): JsonSchema {
  return { type: "string", description };
}

function nullableStringSchema(description: string): JsonSchema {
  return { type: ["string", "null"], description };
}

function integerSchema(description: string): JsonSchema {
  return { type: "integer", minimum: 1, description };
}

function arraySchema(description: string): JsonSchema {
  return {
    type: "array",
    items: { type: "string" },
    description,
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
