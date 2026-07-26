import { randomUUID } from "node:crypto";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import { RelayError } from "../core/errors.js";
import type {
  ConnectionSession,
  RelayRuntime,
} from "../core/runtime.js";
import type {
  MessageIntent,
  RelaySyncEnvelope,
  Task,
} from "../core/types.js";

const A2A_VERSION = "1.0";
const A2A_MEDIA_TYPE = "application/a2a+json";
const RELAY_EXTENSION =
  "https://github.com/Rayha33/relaymesh/blob/main/docs/PROTOCOL.md#relaymesh-a2a-extension-v1";
const messageIntents = new Set<MessageIntent>([
  "inform",
  "request",
  "response",
  "challenge",
  "decision",
  "handoff",
  "blocker",
]);
const sendMessageSchema = z.object({
  message: z.object({
    messageId: z.string().min(1),
    contextId: z.string().optional(),
    taskId: z.string().optional(),
    role: z.literal("ROLE_USER"),
    parts: z.array(z.record(z.string(), z.unknown())).min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
    extensions: z.array(z.string()).optional(),
    referenceTaskIds: z.array(z.string()).optional(),
  }),
  configuration: z
    .object({
      acceptedOutputModes: z.array(z.string()).optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

interface TaskParams {
  taskId: string;
}

interface TaskQuery {
  contextId?: string;
  status?: string;
  pageSize?: string;
  pageToken?: string;
}

export async function registerRelayA2a(
  app: FastifyInstance,
  runtime: RelayRuntime,
  configuredPublicUrl?: string,
): Promise<void> {
  if (!app.hasContentTypeParser(A2A_MEDIA_TYPE)) {
    app.addContentTypeParser(
      A2A_MEDIA_TYPE,
      { parseAs: "string" },
      (_request, body, done) => {
        try {
          done(null, JSON.parse(body.toString()));
        } catch (error) {
          done(error as Error);
        }
      },
    );
  }

  app.get("/.well-known/agent-card.json", async (request, reply) => {
    const baseUrl =
      configuredPublicUrl ??
      `${request.protocol}://${request.headers.host ?? "127.0.0.1:4317"}`;
    return reply
      .header("cache-control", "public, max-age=300")
      .type(A2A_MEDIA_TYPE)
      .send({
        name: "RelayMesh Coordination Agent",
        description:
          "A provider-neutral coordination agent that lets heterogeneous AI agents share durable tasks, messages, checkpoints, artifacts, and crash recovery.",
        supportedInterfaces: [
          {
            url: new URL("/a2a/v1", baseUrl).href,
            protocolBinding: "HTTP+JSON",
            protocolVersion: A2A_VERSION,
          },
        ],
        provider: {
          organization: "RelayMesh open-source project",
          url: "https://github.com/Rayha33/relaymesh",
        },
        version: "0.5.0",
        documentationUrl: "https://github.com/Rayha33/relaymesh",
        capabilities: {
          streaming: false,
          pushNotifications: false,
          extendedAgentCard: false,
          extensions: [
            {
              uri: RELAY_EXTENSION,
              description:
                "Adds a RelayMesh v2 sync envelope containing durable mission, peer, inbox, lease, checkpoint, and artifact state.",
              required: false,
            },
          ],
        },
        securitySchemes: {
          relaymeshTicket: {
            httpAuthSecurityScheme: {
              description:
                "A scoped and revocable RelayMesh connection ticket.",
              scheme: "Bearer",
              bearerFormat: "RelayMesh connection ticket",
            },
          },
        },
        securityRequirements: [
          { schemes: { relaymeshTicket: { list: [] } } },
        ],
        defaultInputModes: ["text/plain", "application/json"],
        defaultOutputModes: ["text/plain", "application/json"],
        skills: [
          {
            id: "durable-mission-coordination",
            name: "Durable Mission Coordination",
            description:
              "Synchronizes an agent with one canonical mission state and assigns compatible work without duplicate ownership.",
            tags: [
              "multi-agent",
              "coordination",
              "checkpoint",
              "crash-recovery",
            ],
            examples: [
              "Synchronize with the mission and continue the next recoverable task.",
            ],
            inputModes: ["text/plain", "application/json"],
            outputModes: ["application/json"],
          },
          {
            id: "cross-model-handoff",
            name: "Cross-Model Handoff",
            description:
              "Moves checkpointed work between model roles while fencing stale writers.",
            tags: ["handoff", "fencing", "interoperability"],
            examples: [
              "Hand this implementation from Claude to a DeepSeek reviewer.",
            ],
            inputModes: ["text/plain", "application/json"],
            outputModes: ["application/json"],
          },
        ],
      });
  });

  app.post("/a2a/v1/message:send", async (request, reply) => {
    const context = await authenticateA2a(request, reply, runtime);
    if (context === null) return reply;
    const parsed = sendMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      return a2aError(
        reply,
        400,
        "INVALID_ARGUMENT",
        "INVALID_REQUEST",
        "The A2A message request is invalid",
      );
    }
    const input = parsed.data;
    if (
      input.message.contextId !== undefined &&
      input.message.contextId !== context.connection.missionId
    ) {
      return a2aError(
        reply,
        400,
        "INVALID_ARGUMENT",
        "INVALID_REQUEST",
        "The message context is outside this connection scope",
        { contextId: input.message.contextId },
      );
    }
    const referencedTask =
      input.message.taskId === undefined
        ? null
        : scopedTask(
            runtime,
            context,
            input.message.taskId,
            reply,
          );
    if (input.message.taskId !== undefined && referencedTask === null) {
      return reply;
    }
    if (
      referencedTask !== null &&
      input.message.contextId !== undefined &&
      input.message.contextId !== referencedTask.missionId
    ) {
      return a2aError(
        reply,
        400,
        "INVALID_ARGUMENT",
        "INVALID_REQUEST",
        "The message context does not match its task",
        { taskId: referencedTask.id },
      );
    }
    for (const referenceTaskId of input.message.referenceTaskIds ?? []) {
      if (
        scopedTask(
          runtime,
          context,
          referenceTaskId,
          reply,
        ) === null
      ) {
        return reply;
      }
    }
    const metadata = input.message.metadata ?? {};
    const content = input.message.parts
      .map((part) =>
        typeof part.text === "string"
          ? part.text
          : "data" in part
            ? JSON.stringify(part.data)
            : JSON.stringify(part),
      )
      .join("\n");
    const requestedIntent = metadata.relaymeshIntent;
    const intent: MessageIntent =
      typeof requestedIntent === "string" &&
      messageIntents.has(requestedIntent as MessageIntent)
        ? (requestedIntent as MessageIntent)
        : "request";
    runtime.sendMessage(
      context.claims,
      {
        toSessionId: null,
        toRole:
          typeof metadata.toRole === "string"
            ? metadata.toRole
            : null,
        intent,
        subject:
          typeof metadata.subject === "string"
            ? metadata.subject.slice(0, 240)
            : "A2A agent message",
        content,
        priority:
          typeof metadata.priority === "number"
            ? Math.max(-100, Math.min(100, Math.trunc(metadata.priority)))
            : 0,
        correlationId: null,
        replyToId: null,
        artifactIds: [],
      },
      input.message.messageId,
    );
    const envelope = runtime.syncSession(
      context.claims,
      { autoClaim: true, includeAcknowledged: false },
      randomUUID(),
    );
    return reply
      .type(A2A_MEDIA_TYPE)
      .send(
        referencedTask !== null
          ? {
              task: toA2aTask(
                runtime,
                referencedTask,
                envelope.work?.task.id === referencedTask.id
                  ? envelope
                  : undefined,
              ),
            }
          : envelope.work === null
          ? {
              message: envelopeMessage(
                envelope,
                usesRelayExtension(request),
              ),
            }
          : {
              task: toA2aTask(
                runtime,
                envelope.work.task,
                envelope,
              ),
            },
      );
  });

  app.get<{ Params: TaskParams }>(
    "/a2a/v1/tasks/:taskId",
    async (request, reply) => {
      const context = await authenticateA2a(request, reply, runtime);
      if (context === null) return reply;
      const task = scopedTask(
        runtime,
        context,
        routeTaskId(request.params),
        reply,
      );
      if (task === null) return reply;
      return reply
        .type(A2A_MEDIA_TYPE)
        .send({ task: toA2aTask(runtime, task) });
    },
  );

  app.get<{ Querystring: TaskQuery }>(
    "/a2a/v1/tasks",
    async (request, reply) => {
      const context = await authenticateA2a(request, reply, runtime);
      if (context === null) return reply;
      if (
        request.query.contextId !== undefined &&
        request.query.contextId !== context.connection.missionId
      ) {
        return reply
          .type(A2A_MEDIA_TYPE)
          .send({
            tasks: [],
            totalSize: 0,
            pageSize: 0,
            nextPageToken: "",
          });
      }
      const requestedPageSize = Number.parseInt(
        request.query.pageSize ?? "100",
        10,
      );
      if (
        !Number.isSafeInteger(requestedPageSize) ||
        requestedPageSize < 1 ||
        requestedPageSize > 100
      ) {
        return a2aError(
          reply,
          400,
          "INVALID_ARGUMENT",
          "INVALID_REQUEST",
          "pageSize must be an integer between 1 and 100",
        );
      }
      const offset = decodePageToken(request.query.pageToken);
      if (offset === null) {
        return a2aError(
          reply,
          400,
          "INVALID_ARGUMENT",
          "INVALID_REQUEST",
          "pageToken is invalid",
        );
      }
      const matching = runtime
        .listTasks(context.connection.missionId)
        .filter(
          (task) =>
            request.query.status === undefined ||
            taskState(task.status) === request.query.status,
        );
      const tasks = matching
        .slice(offset, offset + requestedPageSize)
        .map((task) => toA2aTask(runtime, task));
      const nextOffset = offset + tasks.length;
      return reply
        .type(A2A_MEDIA_TYPE)
        .send({
          tasks,
          totalSize: matching.length,
          pageSize: tasks.length,
          nextPageToken:
            nextOffset < matching.length
              ? Buffer.from(String(nextOffset)).toString("base64url")
              : "",
        });
    },
  );

  app.post<{ Params: TaskParams }>(
    "/a2a/v1/tasks/:taskId:cancel",
    async (request, reply) => {
      const context = await authenticateA2a(request, reply, runtime);
      if (context === null) return reply;
      const task = scopedTask(
        runtime,
        context,
        routeTaskId(request.params),
        reply,
      );
      if (task === null) return reply;
      if (task.status === "cancelled") {
        return reply
          .type(A2A_MEDIA_TYPE)
          .send({ task: toA2aTask(runtime, task) });
      }
      if (["completed", "failed"].includes(task.status)) {
        return a2aError(
          reply,
          400,
          "FAILED_PRECONDITION",
          "TASK_NOT_CANCELABLE",
          `Task ${task.id} is already ${task.status}`,
          { taskId: task.id },
        );
      }
      const cancelled = runtime.cancelTask(
        context.claims,
        task.id,
        "a2a.cancelled",
        randomUUID(),
      );
      return reply
        .type(A2A_MEDIA_TYPE)
        .send({ task: toA2aTask(runtime, cancelled) });
    },
  );
}

async function authenticateA2a(
  request: FastifyRequest,
  reply: FastifyReply,
  runtime: RelayRuntime,
): Promise<ConnectionSession | null> {
  const query = request.query as Record<string, unknown>;
  const rawVersion =
    request.headers["a2a-version"] ??
    query["A2A-Version"] ??
    query["a2a-version"];
  const version =
    typeof rawVersion === "string" ? rawVersion : "0.3";
  if (version !== A2A_VERSION) {
    a2aError(
      reply,
      400,
      "FAILED_PRECONDITION",
      "VERSION_NOT_SUPPORTED",
      `RelayMesh A2A supports version ${A2A_VERSION}`,
      { requestedVersion: version },
    );
    return null;
  }
  const authorization = request.headers.authorization;
  if (
    typeof authorization !== "string" ||
    !authorization.startsWith("Bearer ") ||
    authorization.length <= "Bearer ".length
  ) {
    reply.header("www-authenticate", 'Bearer realm="relaymesh-a2a"');
    a2aError(
      reply,
      401,
      "UNAUTHENTICATED",
      "AUTHENTICATION_REQUIRED",
      "Use a RelayMesh scoped connection ticket as the Bearer token",
    );
    return null;
  }
  try {
    const context = await runtime.ensureConnectionSession(
      authorization.slice("Bearer ".length),
    );
    runtime.heartbeat(context.claims, randomUUID());
    return context;
  } catch (error) {
    const statusCode =
      error instanceof RelayError ? error.statusCode : 500;
    a2aError(
      reply,
      statusCode,
      statusCode === 401 ? "UNAUTHENTICATED" : "INTERNAL",
      statusCode === 401 ? "AUTHENTICATION_REQUIRED" : "INTERNAL",
      error instanceof Error ? error.message : "A2A authentication failed",
    );
    return null;
  }
}

function scopedTask(
  runtime: RelayRuntime,
  context: ConnectionSession,
  taskId: string,
  reply: FastifyReply,
): Task | null {
  try {
    const task = runtime.getTask(taskId);
    if (task.missionId !== context.connection.missionId) {
      throw new Error("Task is outside this connection scope");
    }
    return task;
  } catch {
    a2aError(
      reply,
      404,
      "NOT_FOUND",
      "TASK_NOT_FOUND",
      "The task does not exist or is outside this connection scope",
      { taskId },
    );
    return null;
  }
}

function routeTaskId(params: TaskParams): string {
  const value =
    params.taskId ??
    Object.values(params as unknown as Record<string, string>)[0] ??
    "";
  return value.endsWith(":cancel")
    ? value.slice(0, -":cancel".length)
    : value;
}

function envelopeMessage(
  envelope: RelaySyncEnvelope,
  includeExtension: boolean,
) {
  const message = {
    messageId: randomUUID(),
    contextId: envelope.mission.id,
    role: "ROLE_AGENT",
    parts: [
      {
        data: envelope,
        mediaType: "application/json",
      },
    ],
  };
  return includeExtension
    ? { ...message, extensions: [RELAY_EXTENSION] }
    : message;
}

function usesRelayExtension(request: FastifyRequest): boolean {
  const extensions = request.headers["a2a-extensions"];
  return (
    typeof extensions === "string" &&
    extensions
      .split(",")
      .map((extension) => extension.trim())
      .includes(RELAY_EXTENSION)
  );
}

function decodePageToken(value: string | undefined): number | null {
  if (value === undefined || value.length === 0) return 0;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const offset = Number.parseInt(decoded, 10);
    return Number.isSafeInteger(offset) &&
      offset >= 0 &&
      String(offset) === decoded
      ? offset
      : null;
  } catch {
    return null;
  }
}

function toA2aTask(
  runtime: RelayRuntime,
  task: Task,
  envelope?: RelaySyncEnvelope,
) {
  const checkpoint = runtime.getLatestCheckpoint(task.id);
  const artifacts: Array<{
    artifactId: string;
    name: string;
    parts: Array<{ data: unknown; mediaType: string }>;
    metadata: Record<string, unknown>;
  }> = runtime
    .listArtifacts(task.missionId)
    .filter((artifact) => artifact.taskId === task.id)
    .map((artifact) => ({
      artifactId: artifact.id,
      name: artifact.name,
      parts: [
        {
          data: {
            mimeType: artifact.mimeType,
            sizeBytes: artifact.sizeBytes,
            sha256: artifact.sha256,
          },
          mediaType: "application/json",
        },
      ],
      metadata: artifact.metadata,
    }));
  if (envelope !== undefined) {
    artifacts.push({
      artifactId: `relaymesh-envelope-${envelope.eventSequence}`,
      name: "relaymesh-sync-envelope.json",
      parts: [
        {
          data: envelope,
          mediaType: "application/json",
        },
      ],
      metadata: { protocol: "relaymesh/2" },
    });
  }
  return {
    id: task.id,
    contextId: task.missionId,
    status: {
      state: taskState(task.status),
      timestamp: task.updatedAt,
      message: {
        messageId: randomUUID(),
        contextId: task.missionId,
        taskId: task.id,
        role: "ROLE_AGENT",
        parts: [
          {
            text:
              checkpoint?.nextAction ||
              (task.status === "queued"
                ? task.description
                : `Task is ${task.status}`),
            mediaType: "text/plain",
          },
        ],
      },
    },
    artifacts,
    metadata: {
      relaymeshProtocol: "relaymesh/2",
      assignedRole: task.assignedRole,
      requiredCapabilities: task.requiredCapabilities,
      dependencies: task.dependencies,
      attempt: task.attempt,
      maxAttempts: task.maxAttempts,
      checkpointId: checkpoint?.id ?? null,
    },
  };
}

function taskState(status: Task["status"]): string {
  switch (status) {
    case "queued":
      return "TASK_STATE_SUBMITTED";
    case "leased":
    case "running":
      return "TASK_STATE_WORKING";
    case "completed":
      return "TASK_STATE_COMPLETED";
    case "failed":
      return "TASK_STATE_FAILED";
    case "cancelled":
      return "TASK_STATE_CANCELED";
  }
}

function a2aError(
  reply: FastifyReply,
  statusCode: number,
  status: string,
  reason: string,
  message: string,
  metadata: Record<string, string> = {},
) {
  return reply
    .status(statusCode)
    .type(A2A_MEDIA_TYPE)
    .send({
      error: {
        code: statusCode,
        status,
        message,
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason,
            domain: "a2a-protocol.org",
            metadata: {
              ...metadata,
              timestamp: new Date().toISOString(),
            },
          },
        ],
      },
    });
}
