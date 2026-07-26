import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SessionClaims } from "../core/crypto.js";
import {
  joinSessionSchema,
  type CheckpointInput,
  type CompleteTaskInput,
  type CreateArtifactInput,
  type FailTaskInput,
  type HandoffTaskInput,
  type JoinSessionInput,
  type SendMessageInput,
  type SyncSessionInput,
} from "../core/schemas.js";
import type {
  JoinedSession,
  RelayRuntime,
} from "../core/runtime.js";
import type { Agent, AgentSession } from "../core/types.js";
import {
  createRelayMcpServer,
  type RelayMcpSession,
} from "./server.js";

interface Connection {
  endpointKey: string;
  relaySessionId: string;
  credentialDigest: Buffer;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  heartbeatTimer: NodeJS.Timeout;
}

interface ConnectionIdentity {
  endpointKey: string;
  missionId: string;
  agent: Agent;
  credential: string;
  joinInput: JoinSessionInput;
  connectionId: string | null;
}

interface McpParams {
  missionId: string;
  agentId: string;
}

interface TicketParams {
  ticket: string;
}

interface McpQuery {
  model?: string;
  role?: string;
  capabilities?: string;
  recoveryFromSessionId?: string;
}

export async function registerRelayMcpHttp(
  app: FastifyInstance,
  runtime: RelayRuntime,
): Promise<void> {
  const connections = new Map<string, Connection>();

  app.addHook("onClose", async () => {
    const active = [...connections.values()];
    connections.clear();
    await Promise.all(
      active.map(async (connection) => {
        clearInterval(connection.heartbeatTimer);
        await connection.transport.close();
        await connection.server.close();
      }),
    );
  });

  app.route<{ Params: McpParams; Querystring: McpQuery }>({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp/:missionId/:agentId",
    handler: async (request, reply) => {
      const agentKey = bearer(request, reply);
      if (agentKey === null) {
        return reply;
      }
      const agent = runtime.authenticateAgent(
        request.params.agentId,
        agentKey,
      );
      const endpointKey = `agent:${request.params.missionId}:${agent.id}`;
      const identity: ConnectionIdentity = {
        endpointKey,
        missionId: request.params.missionId,
        agent,
        credential: agentKey,
        connectionId: null,
        joinInput: joinSessionSchema.parse({
          model: limited(request.query.model, "remote-mcp", 120),
          role: limited(request.query.role, "worker", 80),
          capabilities: csv(request.query.capabilities ?? "general"),
          recoveryFromSessionId:
            request.query.recoveryFromSessionId?.trim() || null,
        }),
      };
      return handleMcpRequest(
        request,
        reply,
        identity,
        runtime,
        connections,
        app,
      );
    },
  });

  app.route<{ Params: TicketParams }>({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp/connect/:ticket",
    logLevel: "silent",
    handler: async (request, reply) => {
      const ticket = runtime.authenticateConnectionTicket(
        request.params.ticket,
      );
      const agent = runtime.getAgent(ticket.agentId);
      const endpointKey = `ticket:${ticket.id}`;
      const identity: ConnectionIdentity = {
        endpointKey,
        missionId: ticket.missionId,
        agent,
        credential: request.params.ticket,
        connectionId: ticket.id,
        joinInput: {
          model: ticket.model,
          role: ticket.role,
          capabilities: ticket.capabilities,
          recoveryFromSessionId: null,
        },
      };
      return handleMcpRequest(
        request,
        reply,
        identity,
        runtime,
        connections,
        app,
      );
    },
  });
}

async function handleMcpRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  identity: ConnectionIdentity,
  runtime: RelayRuntime,
  connections: Map<string, Connection>,
  app: FastifyInstance,
) {
  const sessionId = header(request, "mcp-session-id");
  let connection =
    sessionId === null ? undefined : connections.get(sessionId);

  if (connection !== undefined) {
    if (
      connection.endpointKey !== identity.endpointKey ||
      !sameDigest(
        connection.credentialDigest,
        digest(identity.credential),
      )
    ) {
      return jsonRpcError(
        reply,
        403,
        -32001,
        "MCP session credentials do not match this connection",
      );
    }
    if (
      runtime.getSession(connection.relaySessionId).status !== "active"
    ) {
      return jsonRpcError(
        reply,
        401,
        -32001,
        "The RelayMesh agent session is no longer active; reconnect to recover",
      );
    }
  } else {
    if (sessionId !== null) {
      return jsonRpcError(
        reply,
        404,
        -32001,
        "Unknown or expired MCP session",
      );
    }
    if (request.method !== "POST" || !isInitializeRequest(request.body)) {
      return jsonRpcError(
        reply,
        400,
        -32000,
        "Initialize the MCP connection before sending other requests",
      );
    }
    connection = await createConnection(
      identity,
      runtime,
      connections,
      app,
    );
  }

  reply.hijack();
  try {
    await connection.transport.handleRequest(
      request.raw,
      reply.raw,
      request.body,
    );
  } catch (error) {
    app.log.error({ err: error }, "Remote MCP request failed");
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(500, { "content-type": "application/json" });
      reply.raw.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal MCP error" },
          id: null,
        }),
      );
    }
  }
  return reply;
}

async function createConnection(
  identity: ConnectionIdentity,
  runtime: RelayRuntime,
  connections: Map<string, Connection>,
  app: FastifyInstance,
): Promise<Connection> {
  let joined: JoinedSession;
  let claims: SessionClaims;
  if (identity.connectionId === null) {
    const joinInput: JoinSessionInput = {
      ...identity.joinInput,
      recoveryFromSessionId:
        identity.joinInput.recoveryFromSessionId ??
        runtime.findRecoverySession(
          identity.missionId,
          identity.agent.id,
        ),
    };
    joined = await runtime.joinSession(
      identity.missionId,
      identity.agent,
      joinInput,
      randomUUID(),
    );
    claims = await runtime.authenticateSession(joined.sessionToken);
  } else {
    const connection = await runtime.ensureConnectionSession(
      identity.credential,
    );
    joined = {
      session: connection.session,
      sessionToken: "",
      snapshot: runtime.getMissionSnapshot(
        connection.connection.missionId,
        connection.session.id,
      ),
    };
    claims = connection.claims;
  }
  const session = new RuntimeMcpSession(runtime, claims, joined.session);
  const server = createRelayMcpServer(session, joined);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
    onsessioninitialized(sessionId) {
      connections.set(sessionId, connection);
    },
  });
  const heartbeatTimer = setInterval(() => {
    void session.heartbeat().catch((error: unknown) => {
      app.log.warn(
        {
          err: error,
          missionId: identity.missionId,
          agentId: identity.agent.id,
          relaySessionId: joined.session.id,
        },
        "Remote MCP heartbeat failed",
      );
    });
  }, 10_000);
  heartbeatTimer.unref();
  const connection: Connection = {
    endpointKey: identity.endpointKey,
    relaySessionId: joined.session.id,
    credentialDigest: digest(identity.credential),
    transport,
    server,
    heartbeatTimer,
  };
  transport.onclose = () => {
    clearInterval(heartbeatTimer);
    try {
      if (runtime.getSession(joined.session.id).status === "active") {
        runtime.leaveSession(claims);
      }
    } catch (error) {
      app.log.warn(
        { err: error, relaySessionId: joined.session.id },
        "Could not finalize closed MCP session",
      );
    }
    const sessionId = transport.sessionId;
    if (sessionId !== undefined) {
      connections.delete(sessionId);
    }
  };
  await server.connect(
    transport as Parameters<typeof server.connect>[0],
  );
  return connection;
}

class RuntimeMcpSession implements RelayMcpSession {
  constructor(
    private readonly runtime: RelayRuntime,
    private readonly claims: SessionClaims,
    readonly identity: AgentSession,
  ) {}

  async sync(input: SyncSessionInput) {
    return this.runtime.syncSession(
      this.claims,
      input,
      randomUUID(),
    );
  }

  async heartbeat() {
    return this.runtime.heartbeat(this.claims, randomUUID());
  }

  async claim() {
    return this.runtime.claimTask(this.claims, randomUUID());
  }

  async checkpoint(taskId: string, input: CheckpointInput) {
    return this.runtime.checkpointTask(
      this.claims,
      taskId,
      input,
      randomUUID(),
    );
  }

  async complete(taskId: string, input: CompleteTaskInput) {
    return this.runtime.completeTask(
      this.claims,
      taskId,
      input,
      randomUUID(),
    );
  }

  async fail(taskId: string, input: FailTaskInput) {
    return this.runtime.failTask(
      this.claims,
      taskId,
      input,
      randomUUID(),
    );
  }

  async handoff(taskId: string, input: HandoffTaskInput) {
    return this.runtime.handoffTask(
      this.claims,
      taskId,
      input,
      randomUUID(),
    );
  }

  async sendMessage(input: SendMessageInput) {
    return this.runtime.sendMessage(this.claims, input, randomUUID());
  }

  async inbox(includeAcknowledged = false) {
    return this.runtime.listInbox(this.claims, includeAcknowledged);
  }

  async acknowledge(messageId: string) {
    return this.runtime.acknowledgeMessage(
      this.claims,
      messageId,
      randomUUID(),
    );
  }

  async publishArtifact(input: CreateArtifactInput) {
    return this.runtime.createArtifact(this.claims, input, randomUUID());
  }
}

function bearer(
  request: FastifyRequest,
  reply: FastifyReply,
): string | null {
  const authorization = request.headers.authorization;
  if (
    typeof authorization !== "string" ||
    !authorization.startsWith("Bearer ") ||
    authorization.length <= "Bearer ".length
  ) {
    void reply
      .header("www-authenticate", 'Bearer realm="relaymesh"')
      .status(401)
      .send({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Use the RelayMesh agent key as a Bearer token",
        },
        id: null,
      });
    return null;
  }
  return authorization.slice("Bearer ".length);
}

function header(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function jsonRpcError(
  reply: FastifyReply,
  statusCode: number,
  code: number,
  message: string,
) {
  return reply.status(statusCode).send({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function sameDigest(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function csv(value: string): string[] {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 100);
  return items.length > 0 ? items : ["general"];
}

function limited(
  value: string | undefined,
  fallback: string,
  maxLength: number,
): string {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0
    ? fallback
    : normalized.slice(0, maxLength);
}
