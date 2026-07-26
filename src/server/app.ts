import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { ZodError, type ZodType } from "zod";
import { RelayError } from "../core/errors.js";
import { RelayRuntime } from "../core/runtime.js";
import {
  checkpointSchema,
  completeTaskSchema,
  createAgentSchema,
  createArtifactSchema,
  createConnectionTicketSchema,
  createMissionSchema,
  createTaskSchema,
  failTaskSchema,
  handoffTaskSchema,
  joinSessionSchema,
  sendMessageSchema,
  syncSessionSchema,
  updateMissionSchema,
} from "../core/schemas.js";
import type { SessionClaims } from "../core/crypto.js";
import { relayFunctionTools } from "../sdk/tools.js";
import type { RelayConfig } from "./config.js";

declare module "fastify" {
  interface FastifyRequest {
    sessionClaims?: SessionClaims;
  }
}

export interface RelayApp {
  app: FastifyInstance;
  runtime: RelayRuntime;
  sweep: () => void;
}

export async function buildApp(config: RelayConfig): Promise<RelayApp> {
  const app = Fastify({
    logger:
      process.env.NODE_ENV === "test"
        ? false
        : {
            level: process.env.LOG_LEVEL ?? "info",
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.x-agent-key",
                "res.headers.set-cookie",
              ],
              censor: "[REDACTED]",
            },
          },
    bodyLimit: 15 * 1024 * 1024,
    trustProxy: false,
    requestIdHeader: "x-request-id",
  });
  const runtime = new RelayRuntime({
    databasePath: config.databasePath,
    dataDirectory: config.dataDirectory,
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    leaseDurationMs: config.leaseDurationMs,
    sessionTtlMs: config.sessionTtlMs,
    ...(config.adminToken === undefined
      ? {}
      : { adminToken: config.adminToken }),
  });

  await app.register(cors, {
    origin(origin, callback) {
      if (
        origin === undefined ||
        /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)
      ) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed"), false);
    },
    allowedHeaders: [
      "authorization",
      "a2a-extensions",
      "a2a-version",
      "content-type",
      "idempotency-key",
      "x-agent-id",
      "x-agent-key",
    ],
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
      },
    },
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (request) =>
      request.headers["x-agent-id"]?.toString() ?? request.ip,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      void reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: error.issues,
          requestId: request.id,
        },
      });
      return;
    }
    if (error instanceof RelayError) {
      void reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          requestId: request.id,
        },
      });
      return;
    }
    request.log.error({ err: error }, "Unhandled request error");
    void reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "An internal error occurred",
        requestId: request.id,
      },
    });
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "relaymesh",
    version: "0.3.0",
    time: new Date().toISOString(),
  }));

  app.get("/.well-known/relaymesh.json", async (_request, reply) =>
    reply
      .header("cache-control", "public, max-age=300")
      .send({
        name: "RelayMesh coordination runtime",
        description:
          "Durable missions, task leases, checkpoints, messages, artifacts, and crash recovery for heterogeneous AI agents.",
        version: "0.3.0",
        protocol: "relaymesh/2",
        documentationUrl: "https://github.com/Rayha33/relaymesh",
        transports: {
          rest: {
            basePath: "/api/v1",
            authentication: [
              "admin-bearer",
              "agent-key",
              "session-bearer",
            ],
          },
          mcp: {
            transports: [
              {
                type: "stdio",
                command: "relaymesh-mcp",
              },
              {
                type: "streamable-http",
                pathTemplate: "/mcp/{missionId}/{agentId}",
                authentication: "agent-key-bearer",
              },
              {
                type: "streamable-http",
                pathTemplate: "/mcp/connect/{scopedTicket}",
                authentication: "scoped-revocable-url",
              },
            ],
          },
          a2a: {
            agentCardPath: "/.well-known/agent-card.json",
            basePath: "/a2a/v1",
            protocolBinding: "HTTP+JSON",
            protocolVersion: "1.0",
            authentication: "scoped-ticket-bearer",
          },
        },
        primitives: [
          "sync-envelopes",
          "missions",
          "sessions",
          "tasks",
          "leases",
          "fencing-tokens",
          "checkpoints",
          "messages",
          "artifacts",
          "signed-events",
          "recovery",
          "atomic-handoff",
        ],
      }),
  );
  app.get(
    "/.well-known/relaymesh-tools.json",
    async (_request, reply) =>
      reply
        .header("cache-control", "public, max-age=300")
        .send({
          name: "RelayMesh OpenAI-compatible function tools",
          protocol: "relaymesh/2",
          instructions: [
            "Call relay_sync first when starting or reconnecting.",
            "Claim work before acting and checkpoint meaningful progress.",
            "Use durable typed messages to cooperate with other model sessions.",
            "Use relay_handoff to atomically checkpoint and transfer unfinished work.",
            "Complete or fail work with the current lease and fencing token.",
          ],
          tools: relayFunctionTools,
        }),
  );

  const requireAdmin = async (
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> => {
    runtime.authenticateAdmin(readBearer(request));
  };
  const requireSession = async (
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> => {
    request.sessionClaims = await runtime.authenticateSession(
      readBearer(request),
    );
  };

  app.get(
    "/api/v1/admin/auth",
    { onRequest: requireAdmin },
    async () => ({ authenticated: true }),
  );
  app.get(
    "/api/v1/admin/token-location",
    { onRequest: requireAdmin },
    async () => ({ path: runtime.adminTokenPath }),
  );
  app.get(
    "/api/v1/admin/overview",
    { onRequest: requireAdmin },
    async () => runtime.getOverview(),
  );
  app.get(
    "/api/v1/admin/public-key",
    { onRequest: requireAdmin },
    async () => ({ algorithm: "Ed25519", publicKey: runtime.publicKey }),
  );

  app.get(
    "/api/v1/agents",
    { onRequest: requireAdmin },
    async () => runtime.listAgents(),
  );
  app.post(
    "/api/v1/agents",
    { onRequest: requireAdmin },
    async (request, reply) => {
      const result = runtime.createAgent(parse(createAgentSchema, request.body));
      return reply.status(201).send(result);
    },
  );
  app.post<{ Params: { agentId: string } }>(
    "/api/v1/agents/:agentId/revoke",
    { onRequest: requireAdmin },
    async (request) => runtime.revokeAgent(request.params.agentId),
  );
  app.get(
    "/api/v1/connections",
    { onRequest: requireAdmin },
    async () => runtime.listConnectionTickets(),
  );
  app.post<{ Params: { missionId: string } }>(
    "/api/v1/missions/:missionId/connections",
    { onRequest: requireAdmin },
    async (request, reply) =>
      reply
        .status(201)
        .send(
          runtime.createConnectionTicket(
            request.params.missionId,
            parse(createConnectionTicketSchema, request.body),
          ),
        ),
  );
  app.post<{ Params: { connectionId: string } }>(
    "/api/v1/connections/:connectionId/revoke",
    { onRequest: requireAdmin },
    async (request) =>
      runtime.revokeConnectionTicket(request.params.connectionId),
  );

  app.get(
    "/api/v1/missions",
    { onRequest: requireAdmin },
    async () => runtime.listMissions(),
  );
  app.post(
    "/api/v1/missions",
    { onRequest: requireAdmin },
    async (request, reply) =>
      reply
        .status(201)
        .send(runtime.createMission(parse(createMissionSchema, request.body))),
  );
  app.get<{ Params: { missionId: string } }>(
    "/api/v1/missions/:missionId",
    { onRequest: requireAdmin },
    async (request) => runtime.getMissionSnapshot(request.params.missionId),
  );
  app.patch<{ Params: { missionId: string } }>(
    "/api/v1/missions/:missionId",
    { onRequest: requireAdmin },
    async (request) => {
      const input = parse(updateMissionSchema, request.body);
      return runtime.updateMissionStatus(request.params.missionId, input.status);
    },
  );
  app.post<{ Params: { missionId: string } }>(
    "/api/v1/missions/:missionId/tasks",
    { onRequest: requireAdmin },
    async (request, reply) =>
      reply
        .status(201)
        .send(
          runtime.createTask(
            request.params.missionId,
            parse(createTaskSchema, request.body),
          ),
        ),
  );

  app.get<{ Params: { missionId: string } }>(
    "/api/v1/missions/:missionId/events",
    { onRequest: requireAdmin },
    async (request) => runtime.events.list(request.params.missionId),
  );
  app.get<{ Params: { missionId: string } }>(
    "/api/v1/missions/:missionId/events/verify",
    { onRequest: requireAdmin },
    async (request) => runtime.events.verify(request.params.missionId),
  );
  app.post(
    "/api/v1/admin/recover",
    { onRequest: requireAdmin },
    async () => runtime.recover(),
  );

  app.post<{ Params: { missionId: string } }>(
    "/api/v1/missions/:missionId/sessions",
    async (request, reply) => {
      const agentId = requiredHeader(request, "x-agent-id");
      const agentKey = requiredHeader(request, "x-agent-key");
      const agent = runtime.authenticateAgent(agentId, agentKey);
      const result = await runtime.joinSession(
        request.params.missionId,
        agent,
        parse(joinSessionSchema, request.body),
        idempotencyKey(request),
      );
      return reply.status(201).send(result);
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/heartbeat",
    { onRequest: requireSession },
    async (request) => {
      const claims = sessionClaims(request);
      assertPathSession(claims, request.params.sessionId);
      return runtime.heartbeat(claims, idempotencyKey(request));
    },
  );
  app.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/sync",
    { onRequest: requireSession },
    async (request) => {
      const claims = sessionClaims(request);
      assertPathSession(claims, request.params.sessionId);
      return runtime.syncSession(
        claims,
        parse(syncSessionSchema, request.body ?? {}),
        idempotencyKey(request),
      );
    },
  );
  app.post<{ Params: { sessionId: string } }>(
    "/api/v1/sessions/:sessionId/leave",
    { onRequest: requireSession },
    async (request) => {
      const claims = sessionClaims(request);
      assertPathSession(claims, request.params.sessionId);
      return runtime.leaveSession(claims);
    },
  );

  app.post<{ Params: { missionId: string } }>(
    "/api/v1/missions/:missionId/tasks/claim",
    { onRequest: requireSession },
    async (request) => {
      const claims = sessionClaims(request);
      assertPathMission(claims, request.params.missionId);
      return runtime.claimTask(claims, idempotencyKey(request));
    },
  );
  app.post<{ Params: { taskId: string } }>(
    "/api/v1/tasks/:taskId/checkpoints",
    { onRequest: requireSession },
    async (request, reply) =>
      reply
        .status(201)
        .send(
          runtime.checkpointTask(
            sessionClaims(request),
            request.params.taskId,
            parse(checkpointSchema, request.body),
            idempotencyKey(request),
          ),
        ),
  );
  app.post<{ Params: { taskId: string } }>(
    "/api/v1/tasks/:taskId/complete",
    { onRequest: requireSession },
    async (request) =>
      runtime.completeTask(
        sessionClaims(request),
        request.params.taskId,
        parse(completeTaskSchema, request.body),
        idempotencyKey(request),
      ),
  );
  app.post<{ Params: { taskId: string } }>(
    "/api/v1/tasks/:taskId/fail",
    { onRequest: requireSession },
    async (request) =>
      runtime.failTask(
        sessionClaims(request),
        request.params.taskId,
        parse(failTaskSchema, request.body),
        idempotencyKey(request),
      ),
  );
  app.post<{ Params: { taskId: string } }>(
    "/api/v1/tasks/:taskId/handoff",
    { onRequest: requireSession },
    async (request) =>
      runtime.handoffTask(
        sessionClaims(request),
        request.params.taskId,
        parse(handoffTaskSchema, request.body),
        idempotencyKey(request),
      ),
  );

  app.post<{ Params: { missionId: string } }>(
    "/api/v1/missions/:missionId/messages",
    { onRequest: requireSession },
    async (request, reply) => {
      const claims = sessionClaims(request);
      assertPathMission(claims, request.params.missionId);
      return reply
        .status(201)
        .send(
          runtime.sendMessage(
            claims,
            parse(sendMessageSchema, request.body),
            idempotencyKey(request),
          ),
        );
    },
  );
  app.get<{ Params: { sessionId: string }; Querystring: { all?: string } }>(
    "/api/v1/sessions/:sessionId/inbox",
    { onRequest: requireSession },
    async (request) => {
      const claims = sessionClaims(request);
      assertPathSession(claims, request.params.sessionId);
      return runtime.listInbox(claims, request.query.all === "true");
    },
  );
  app.post<{ Params: { messageId: string } }>(
    "/api/v1/messages/:messageId/ack",
    { onRequest: requireSession },
    async (request) =>
      runtime.acknowledgeMessage(
        sessionClaims(request),
        request.params.messageId,
        idempotencyKey(request),
      ),
  );

  app.post<{ Params: { missionId: string } }>(
    "/api/v1/missions/:missionId/artifacts",
    { onRequest: requireSession },
    async (request, reply) => {
      const claims = sessionClaims(request);
      assertPathMission(claims, request.params.missionId);
      return reply
        .status(201)
        .send(
          runtime.createArtifact(
            claims,
            parse(createArtifactSchema, request.body),
            idempotencyKey(request),
          ),
        );
    },
  );
  app.get<{ Params: { missionId: string } }>(
    "/api/v1/missions/:missionId/artifacts",
    { onRequest: requireSession },
    async (request) => {
      const claims = sessionClaims(request);
      assertPathMission(claims, request.params.missionId);
      return runtime.listArtifacts(request.params.missionId);
    },
  );
  app.get<{ Params: { artifactId: string } }>(
    "/api/v1/artifacts/:artifactId",
    { onRequest: requireSession },
    async (request, reply) => {
      const result = runtime.readArtifact(
        sessionClaims(request),
        request.params.artifactId,
      );
      return reply
        .type(result.artifact.mimeType)
        .header("x-content-sha256", result.artifact.sha256)
        .header(
          "content-disposition",
          `attachment; filename="${safeFilename(result.artifact.name)}"`,
        )
        .send(result.content);
    },
  );

  const { registerRelayMcpHttp } = await import("../mcp/http.js");
  await registerRelayMcpHttp(app, runtime);
  const { registerRelayA2a } = await import("../a2a/index.js");
  await registerRelayA2a(app, runtime, config.publicUrl);

  const installedWebRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../web",
  );
  const workingTreeWebRoot = resolve(process.cwd(), "dist/web");
  const webRoot = existsSync(resolve(installedWebRoot, "index.html"))
    ? installedWebRoot
    : workingTreeWebRoot;
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (
        request.method === "GET" &&
        !request.url.startsWith("/api/") &&
        request.headers.accept?.includes("text/html")
      ) {
        return reply.sendFile("index.html");
      }
      return reply.status(404).send({
        error: {
          code: "NOT_FOUND",
          message: "Route not found",
          requestId: request.id,
        },
      });
    });
  }

  return {
    app,
    runtime,
    sweep: () => {
      const report = runtime.recover();
      if (
        report.lostSessions.length > 0 ||
        report.expiredLeases.length > 0
      ) {
        app.log.warn({ report }, "Recovered abandoned agent work");
      }
    },
  };
}

function parse<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

function readBearer(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    throw new RelayError(
      401,
      "AUTHENTICATION_REQUIRED",
      "Bearer token is required",
    );
  }
  return authorization.slice("Bearer ".length);
}

function requiredHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new RelayError(
      401,
      "AUTHENTICATION_REQUIRED",
      `${name} header is required`,
    );
  }
  return value;
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers["idempotency-key"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sessionClaims(request: FastifyRequest): SessionClaims {
  if (request.sessionClaims === undefined) {
    throw new RelayError(
      401,
      "AUTHENTICATION_REQUIRED",
      "Agent session is required",
    );
  }
  return request.sessionClaims;
}

function assertPathSession(claims: SessionClaims, sessionId: string): void {
  if (claims.sessionId !== sessionId) {
    throw new RelayError(
      403,
      "SESSION_SCOPE",
      "Token does not belong to this session",
    );
  }
}

function assertPathMission(claims: SessionClaims, missionId: string): void {
  if (claims.missionId !== missionId) {
    throw new RelayError(
      403,
      "MISSION_SCOPE",
      "Token does not belong to this mission",
    );
  }
}

function safeFilename(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}
