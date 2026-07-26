import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  createSecret,
  ensurePrivateFile,
  hashSecret,
  sha256,
  SigningAuthority,
  verifySecret,
  type SessionClaims,
} from "./crypto.js";
import { parseJson, RelayDatabase } from "./database.js";
import { conflict, forbidden, notFound, RelayError } from "./errors.js";
import { EventStore } from "./event-store.js";
import type {
  CheckpointInput,
  CompleteTaskInput,
  CreateConnectionTicketInput,
  CreateAgentInput,
  CreateArtifactInput,
  CreateMissionInput,
  CreateTaskInput,
  FailTaskInput,
  JoinSessionInput,
  SendMessageInput,
} from "./schemas.js";
import type {
  Agent,
  AgentSession,
  Artifact,
  Checkpoint,
  ClaimResult,
  ConnectionTicket,
  Lease,
  Mission,
  MissionSnapshot,
  RecoveryReport,
  RelayMessage,
  SessionStatus,
  Task,
} from "./types.js";

export interface RelayRuntimeOptions {
  databasePath: string;
  dataDirectory: string;
  adminToken?: string;
  heartbeatTimeoutMs?: number;
  leaseDurationMs?: number;
  sessionTtlMs?: number;
  now?: () => Date;
}

export interface AgentRegistration {
  agent: Agent;
  agentKey: string;
}

export interface ConnectionTicketRegistration {
  connection: ConnectionTicket;
  ticket: string;
}

export interface JoinedSession {
  session: AgentSession;
  sessionToken: string;
  snapshot: MissionSnapshot;
}

export interface HeartbeatResult {
  sessionId: string;
  heartbeatAt: string;
  nextHeartbeatDueAt: string;
  inboxCount: number;
  renewedLeases: Array<{ leaseId: string; expiresAt: string }>;
}

interface AgentRow {
  id: string;
  name: string;
  provider: string;
  default_model: string;
  description: string;
  token_hash: string;
  status: "active" | "revoked";
  created_at: string;
}

interface MissionRow {
  id: string;
  title: string;
  objective: string;
  status: Mission["status"];
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: string;
  mission_id: string;
  agent_id: string;
  agent_name: string;
  provider: string;
  model: string;
  role: string;
  capabilities_json: string;
  status: SessionStatus;
  token_jti: string;
  joined_at: string;
  last_heartbeat_at: string;
  expires_at: string;
  recovery_from_session_id: string | null;
}

interface ConnectionTicketRow {
  id: string;
  mission_id: string;
  agent_id: string;
  token_hash: string;
  model: string;
  role: string;
  capabilities_json: string;
  status: ConnectionTicket["status"];
  expires_at: string;
  created_at: string;
}

interface TaskRow {
  id: string;
  mission_id: string;
  parent_task_id: string | null;
  title: string;
  description: string;
  status: Task["status"];
  priority: number;
  requirements_json: string;
  dependencies_json: string;
  assigned_role: string | null;
  max_attempts: number;
  attempt: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  result_json: string | null;
}

interface LeaseRow {
  id: string;
  task_id: string;
  session_id: string;
  fencing_token: number;
  status: Lease["status"];
  acquired_at: string;
  expires_at: string;
  heartbeat_at: string;
}

interface CheckpointRow {
  id: string;
  task_id: string;
  session_id: string;
  lease_id: string;
  summary: string;
  next_action: string;
  decisions_json: string;
  artifacts_json: string;
  opaque_state_json: string | null;
  created_at: string;
}

interface MessageRow {
  id: string;
  mission_id: string;
  sender_session_id: string;
  to_session_id: string | null;
  to_role: string | null;
  intent: RelayMessage["intent"];
  subject: string;
  content: string;
  priority: number;
  correlation_id: string | null;
  reply_to_id: string | null;
  artifacts_json: string;
  created_at: string;
  acknowledged_at: string | null;
}

interface ArtifactRow {
  id: string;
  mission_id: string;
  task_id: string | null;
  creator_session_id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  storage_path: string;
  metadata_json: string;
  created_at: string;
}

interface IdempotencyRow {
  operation: string;
  response_json: string;
  status_code: number;
}

export class RelayRuntime {
  readonly database: RelayDatabase;
  readonly signing: SigningAuthority;
  readonly events: EventStore;
  readonly adminTokenPath: string;
  readonly publicKey: string;
  private readonly dataDirectory: string;
  private readonly heartbeatTimeoutMs: number;
  private readonly leaseDurationMs: number;
  private readonly sessionTtlMs: number;
  private readonly now: () => Date;

  constructor(options: RelayRuntimeOptions) {
    this.dataDirectory = options.dataDirectory;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 30_000;
    this.leaseDurationMs = options.leaseDurationMs ?? 45_000;
    this.sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1_000;
    this.now = options.now ?? (() => new Date());

    mkdirSync(this.dataDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.dataDirectory, "artifacts"), {
      recursive: true,
      mode: 0o700,
    });
    this.database = new RelayDatabase(options.databasePath);
    this.signing = new SigningAuthority(join(this.dataDirectory, "keys"));
    this.events = new EventStore(this.database, this.signing);
    this.publicKey = this.signing.publicKeyPem;

    this.adminTokenPath = join(this.dataDirectory, "admin-token.txt");
    this.initializeAdminToken(options.adminToken);
  }

  close(): void {
    this.database.close();
  }

  private initializeAdminToken(configuredToken: string | undefined): void {
    const existingHash = this.database.getSetting("admin_token_hash");
    if (existingHash !== null) {
      if (
        configuredToken !== undefined &&
        !verifySecret(configuredToken, existingHash)
      ) {
        throw new RelayError(
          500,
          "ADMIN_TOKEN_MISMATCH",
          "Configured admin token does not match the initialized data directory",
        );
      }
      return;
    }

    const token = configuredToken ?? createSecret("rm_admin");
    this.database.setSetting("admin_token_hash", hashSecret(token));
    if (configuredToken === undefined) {
      ensurePrivateFile(this.adminTokenPath, token);
    }
  }

  readLocalAdminToken(): string | null {
    if (!existsSync(this.adminTokenPath)) {
      return null;
    }
    return readFileSync(this.adminTokenPath, "utf8").trim();
  }

  authenticateAdmin(token: string): void {
    const hash = this.database.getSetting("admin_token_hash");
    if (hash === null || !verifySecret(token, hash)) {
      throw new RelayError(401, "INVALID_ADMIN_TOKEN", "Admin token is invalid");
    }
  }

  authenticateAgent(agentId: string, agentKey: string): Agent {
    const row = this.database.raw
      .prepare("SELECT * FROM agents WHERE id = ?")
      .get(agentId) as unknown as AgentRow | undefined;
    if (
      row === undefined ||
      row.status !== "active" ||
      !verifySecret(agentKey, row.token_hash)
    ) {
      throw new RelayError(401, "INVALID_AGENT_KEY", "Agent key is invalid");
    }
    return mapAgent(row);
  }

  async authenticateSession(token: string): Promise<SessionClaims> {
    const claims = await this.signing.verifySessionToken(token);
    const row = this.database.raw
      .prepare(
        "SELECT status, token_jti, expires_at FROM sessions WHERE id = ?",
      )
      .get(claims.sessionId) as
      | { status: SessionStatus; token_jti: string; expires_at: string }
      | undefined;
    if (
      row === undefined ||
      row.status !== "active" ||
      row.token_jti !== claims.jti ||
      new Date(row.expires_at).getTime() <= this.now().getTime()
    ) {
      throw new RelayError(
        401,
        "SESSION_INACTIVE",
        "Agent session is no longer active",
      );
    }
    return claims;
  }

  createAgent(input: CreateAgentInput): AgentRegistration {
    const id = randomUUID();
    const agentKey = createSecret("rm_agent");
    const createdAt = this.timestamp();
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO agents(
            id, name, provider, default_model, description, token_hash, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(
          id,
          input.name,
          input.provider,
          input.defaultModel,
          input.description,
          hashSecret(agentKey),
          createdAt,
        );
      this.events.append({
        missionId: null,
        actorType: "admin",
        actorId: "admin",
        type: "agent.registered",
        payload: {
          agentId: id,
          name: input.name,
          provider: input.provider,
          defaultModel: input.defaultModel,
        },
        createdAt,
      });
    });

    return {
      agent: {
        id,
        name: input.name,
        provider: input.provider,
        defaultModel: input.defaultModel,
        description: input.description,
        status: "active",
        createdAt,
      },
      agentKey,
    };
  }

  listAgents(): Agent[] {
    const rows = this.database.raw
      .prepare("SELECT * FROM agents ORDER BY created_at DESC")
      .all() as unknown as AgentRow[];
    return rows.map(mapAgent);
  }

  revokeAgent(agentId: string): Agent {
    const existing = this.getAgent(agentId);
    const at = this.timestamp();
    this.database.transaction(() => {
      this.database.raw
        .prepare("UPDATE agents SET status = 'revoked' WHERE id = ?")
        .run(agentId);
      this.database.raw
        .prepare(
          "UPDATE sessions SET status = 'revoked' WHERE agent_id = ? AND status = 'active'",
        )
        .run(agentId);
      this.events.append({
        missionId: null,
        actorType: "admin",
        actorId: "admin",
        type: "agent.revoked",
        payload: { agentId, at },
        createdAt: at,
      });
    });
    return { ...existing, status: "revoked" };
  }

  getAgent(agentId: string): Agent {
    const row = this.database.raw
      .prepare("SELECT * FROM agents WHERE id = ?")
      .get(agentId) as unknown as AgentRow | undefined;
    if (row === undefined) {
      throw notFound("Agent", agentId);
    }
    return mapAgent(row);
  }

  createConnectionTicket(
    missionId: string,
    input: CreateConnectionTicketInput,
  ): ConnectionTicketRegistration {
    const mission = this.getMission(missionId);
    if (mission.status !== "active") {
      throw conflict("Connection tickets require an active mission");
    }
    const agent = this.getAgent(input.agentId);
    if (agent.status !== "active") {
      throw conflict("Connection tickets require an active agent");
    }
    const id = randomUUID();
    const ticket = `${id}.${createSecret("rm_connect")}`;
    const createdAt = this.timestamp();
    const expiresAt = new Date(
      this.now().getTime() + input.expiresInHours * 60 * 60 * 1_000,
    ).toISOString();
    const connection: ConnectionTicket = {
      id,
      missionId,
      agentId: agent.id,
      model: input.model,
      role: input.role,
      capabilities: [...new Set(input.capabilities)].sort(),
      status: "active",
      expiresAt,
      createdAt,
    };
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO connection_tickets(
            id, mission_id, agent_id, token_hash, model, role,
            capabilities_json, status, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          connection.id,
          connection.missionId,
          connection.agentId,
          hashSecret(ticket),
          connection.model,
          connection.role,
          JSON.stringify(connection.capabilities),
          connection.expiresAt,
          connection.createdAt,
        );
      this.events.append({
        missionId,
        actorType: "admin",
        actorId: "admin",
        type: "connection.created",
        payload: {
          connectionId: id,
          agentId: agent.id,
          model: connection.model,
          role: connection.role,
          capabilities: connection.capabilities,
          expiresAt,
        },
        createdAt,
      });
    });
    return { connection, ticket };
  }

  listConnectionTickets(): ConnectionTicket[] {
    const rows = this.database.raw
      .prepare(
        "SELECT * FROM connection_tickets ORDER BY created_at DESC",
      )
      .all() as unknown as ConnectionTicketRow[];
    return rows.map(mapConnectionTicket);
  }

  authenticateConnectionTicket(ticket: string): ConnectionTicket {
    const separator = ticket.indexOf(".");
    const id = separator === -1 ? "" : ticket.slice(0, separator);
    const row = this.database.raw
      .prepare("SELECT * FROM connection_tickets WHERE id = ?")
      .get(id) as unknown as ConnectionTicketRow | undefined;
    if (
      row === undefined ||
      row.status !== "active" ||
      new Date(row.expires_at).getTime() <= this.now().getTime() ||
      !verifySecret(ticket, row.token_hash)
    ) {
      throw new RelayError(
        401,
        "INVALID_CONNECTION_TICKET",
        "Connection ticket is invalid, expired, or revoked",
      );
    }
    const agent = this.getAgent(row.agent_id);
    if (agent.status !== "active") {
      throw new RelayError(
        401,
        "INVALID_CONNECTION_TICKET",
        "Connection ticket is invalid, expired, or revoked",
      );
    }
    return mapConnectionTicket(row);
  }

  revokeConnectionTicket(ticketId: string): ConnectionTicket {
    const row = this.database.raw
      .prepare("SELECT * FROM connection_tickets WHERE id = ?")
      .get(ticketId) as unknown as ConnectionTicketRow | undefined;
    if (row === undefined) {
      throw notFound("Connection ticket", ticketId);
    }
    const connection = mapConnectionTicket(row);
    if (connection.status === "revoked") {
      return connection;
    }
    const at = this.timestamp();
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          "UPDATE connection_tickets SET status = 'revoked' WHERE id = ?",
        )
        .run(ticketId);
      this.events.append({
        missionId: connection.missionId,
        actorType: "admin",
        actorId: "admin",
        type: "connection.revoked",
        payload: {
          connectionId: ticketId,
          agentId: connection.agentId,
        },
        createdAt: at,
      });
    });
    return { ...connection, status: "revoked" };
  }

  createMission(input: CreateMissionInput): Mission {
    const id = randomUUID();
    const at = this.timestamp();
    const mission: Mission = {
      id,
      title: input.title,
      objective: input.objective,
      status: "active",
      createdAt: at,
      updatedAt: at,
    };
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO missions(
            id, title, objective, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          mission.id,
          mission.title,
          mission.objective,
          mission.status,
          at,
          at,
        );
      this.events.append({
        missionId: id,
        actorType: "admin",
        actorId: "admin",
        type: "mission.created",
        payload: {
          title: mission.title,
          objective: mission.objective,
          status: mission.status,
        },
        createdAt: at,
      });
    });
    return mission;
  }

  listMissions(): Array<Mission & { taskCount: number; activeSessions: number }> {
    const rows = this.database.raw
      .prepare(
        `SELECT m.*,
          (SELECT COUNT(*) FROM tasks t WHERE t.mission_id = m.id) AS task_count,
          (SELECT COUNT(*) FROM sessions s
           WHERE s.mission_id = m.id AND s.status = 'active') AS active_sessions
         FROM missions m ORDER BY m.updated_at DESC`,
      )
      .all() as unknown as Array<
      MissionRow & { task_count: number; active_sessions: number }
    >;
    return rows.map((row) => ({
      ...mapMission(row),
      taskCount: row.task_count,
      activeSessions: row.active_sessions,
    }));
  }

  getMission(missionId: string): Mission {
    const row = this.database.raw
      .prepare("SELECT * FROM missions WHERE id = ?")
      .get(missionId) as unknown as MissionRow | undefined;
    if (row === undefined) {
      throw notFound("Mission", missionId);
    }
    return mapMission(row);
  }

  updateMissionStatus(
    missionId: string,
    status: Mission["status"],
  ): Mission {
    const mission = this.getMission(missionId);
    if (status === mission.status) {
      return mission;
    }
    const allowed: Record<Mission["status"], Mission["status"][]> = {
      draft: ["active", "cancelled"],
      active: ["paused", "failed", "cancelled"],
      paused: ["active", "failed", "cancelled"],
      completed: [],
      failed: [],
      cancelled: [],
    };
    if (!allowed[mission.status].includes(status)) {
      throw conflict(
        `Mission cannot transition from ${mission.status} to ${status}`,
      );
    }

    const at = this.timestamp();
    this.database.transaction(() => {
      if (status === "failed" || status === "cancelled") {
        this.cancelOpenTasks(missionId, at, `mission.${status}`);
      }
      this.database.raw
        .prepare("UPDATE missions SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, at, missionId);
      this.events.append({
        missionId,
        actorType: "admin",
        actorId: "admin",
        type: "mission.status_changed",
        payload: { from: mission.status, to: status },
        createdAt: at,
      });
      if (status === "active") {
        this.maybeCompleteMission(missionId, at);
      }
    });
    return this.getMission(missionId);
  }

  createTask(missionId: string, input: CreateTaskInput): Task {
    const mission = this.getMission(missionId);
    if (["completed", "failed", "cancelled"].includes(mission.status)) {
      throw conflict("Cannot add work to a terminal mission");
    }
    this.validateTaskReferences(missionId, input);

    const id = randomUUID();
    const at = this.timestamp();
    const task: Task = {
      id,
      missionId,
      parentTaskId: input.parentTaskId,
      title: input.title,
      description: input.description,
      status: "queued",
      priority: input.priority,
      requiredCapabilities: input.requiredCapabilities,
      dependencies: input.dependencies,
      assignedRole: input.assignedRole,
      maxAttempts: input.maxAttempts,
      attempt: 0,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
      result: null,
    };

    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO tasks(
            id, mission_id, parent_task_id, title, description, status, priority,
            requirements_json, dependencies_json, assigned_role, max_attempts,
            attempt, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          id,
          missionId,
          task.parentTaskId,
          task.title,
          task.description,
          task.priority,
          JSON.stringify(task.requiredCapabilities),
          JSON.stringify(task.dependencies),
          task.assignedRole,
          task.maxAttempts,
          at,
          at,
        );
      this.touchMission(missionId, at);
      this.events.append({
        missionId,
        actorType: "admin",
        actorId: "admin",
        type: "task.created",
        payload: {
          taskId: id,
          title: task.title,
          priority: task.priority,
          requiredCapabilities: task.requiredCapabilities,
          dependencies: task.dependencies,
          assignedRole: task.assignedRole,
        },
        createdAt: at,
      });
    });
    return task;
  }

  listTasks(missionId: string): Task[] {
    this.getMission(missionId);
    const rows = this.database.raw
      .prepare(
        "SELECT * FROM tasks WHERE mission_id = ? ORDER BY priority DESC, created_at ASC",
      )
      .all(missionId) as unknown as TaskRow[];
    return rows.map(mapTask);
  }

  getTask(taskId: string): Task {
    const row = this.database.raw
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(taskId) as unknown as TaskRow | undefined;
    if (row === undefined) {
      throw notFound("Task", taskId);
    }
    return mapTask(row);
  }

  async joinSession(
    missionId: string,
    agent: Agent,
    input: JoinSessionInput,
    idempotencyKey?: string,
  ): Promise<JoinedSession> {
    const operation = `session.join:${missionId}`;
    const cached = this.getIdempotent<JoinedSession>(
      agent.id,
      idempotencyKey,
      operation,
    );
    if (cached.found) {
      return cached.value;
    }

    const mission = this.getMission(missionId);
    if (mission.status !== "active") {
      throw conflict("Agents can only join active missions");
    }
    if (input.recoveryFromSessionId !== null) {
      const recoverySession = this.getSession(input.recoveryFromSessionId);
      if (recoverySession.missionId !== missionId) {
        throw forbidden("Recovery session belongs to another mission");
      }
    }

    const id = randomUUID();
    const tokenJti = randomUUID();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);
    const session: AgentSession = {
      id,
      missionId,
      agentId: agent.id,
      agentName: agent.name,
      provider: agent.provider,
      model: input.model,
      role: input.role,
      capabilities: [...new Set(input.capabilities)].sort(),
      status: "active",
      joinedAt: now.toISOString(),
      lastHeartbeatAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      recoveryFromSessionId: input.recoveryFromSessionId,
    };

    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO sessions(
            id, mission_id, agent_id, model, role, capabilities_json, status,
            token_jti, joined_at, last_heartbeat_at, expires_at,
            recovery_from_session_id
          ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          missionId,
          agent.id,
          session.model,
          session.role,
          JSON.stringify(session.capabilities),
          tokenJti,
          session.joinedAt,
          session.lastHeartbeatAt,
          session.expiresAt,
          session.recoveryFromSessionId,
        );
      this.events.append({
        missionId,
        actorType: "agent",
        actorId: id,
        type: "session.joined",
        payload: {
          sessionId: id,
          agentId: agent.id,
          model: session.model,
          role: session.role,
          capabilities: session.capabilities,
          recoveryFromSessionId: session.recoveryFromSessionId,
        },
        createdAt: session.joinedAt,
      });
    });

    const issuedAt = Math.floor(now.getTime() / 1000);
    const sessionToken = await this.signing.issueSessionToken({
      type: "agent-session",
      sessionId: id,
      agentId: agent.id,
      missionId,
      role: session.role,
      capabilities: session.capabilities,
      jti: tokenJti,
      issuedAt,
      expiresAt: Math.floor(expiresAt.getTime() / 1000),
    });
    const response = {
      session,
      sessionToken,
      snapshot: this.getMissionSnapshot(missionId, id),
    };
    this.saveIdempotent(
      agent.id,
      idempotencyKey,
      operation,
      response,
      201,
    );
    return response;
  }

  getSession(sessionId: string): AgentSession {
    const row = this.database.raw
      .prepare(
        `${sessionSelect} WHERE s.id = ?`,
      )
      .get(sessionId) as unknown as SessionRow | undefined;
    if (row === undefined) {
      throw notFound("Session", sessionId);
    }
    return mapSession(row);
  }

  listSessions(missionId: string): AgentSession[] {
    const rows = this.database.raw
      .prepare(
        `${sessionSelect} WHERE s.mission_id = ? ORDER BY s.joined_at DESC`,
      )
      .all(missionId) as unknown as SessionRow[];
    return rows.map(mapSession);
  }

  heartbeat(claims: SessionClaims, idempotencyKey?: string): HeartbeatResult {
    const operation = "session.heartbeat";
    const cached = this.getIdempotent<HeartbeatResult>(
      claims.sessionId,
      idempotencyKey,
      operation,
    );
    if (cached.found) {
      return cached.value;
    }

    const at = this.now();
    const atIso = at.toISOString();
    const leaseExpiry = new Date(at.getTime() + this.leaseDurationMs).toISOString();
    const renewedLeases: Array<{ leaseId: string; expiresAt: string }> = [];

    this.database.transaction(() => {
      const update = this.database.raw
        .prepare(
          `UPDATE sessions SET last_heartbeat_at = ?
           WHERE id = ? AND status = 'active'`,
        )
        .run(atIso, claims.sessionId);
      if (update.changes !== 1) {
        throw conflict("Session is no longer active");
      }

      const leases = this.database.raw
        .prepare(
          `SELECT id FROM leases
           WHERE session_id = ? AND status = 'active'`,
        )
        .all(claims.sessionId) as unknown as Array<{ id: string }>;
      for (const lease of leases) {
        this.database.raw
          .prepare(
            `UPDATE leases SET heartbeat_at = ?, expires_at = ? WHERE id = ?`,
          )
          .run(atIso, leaseExpiry, lease.id);
        renewedLeases.push({ leaseId: lease.id, expiresAt: leaseExpiry });
      }
    });

    const result = {
      sessionId: claims.sessionId,
      heartbeatAt: atIso,
      nextHeartbeatDueAt: new Date(
        at.getTime() + Math.floor(this.heartbeatTimeoutMs / 2),
      ).toISOString(),
      inboxCount: this.countInbox(claims),
      renewedLeases,
    };
    this.saveIdempotent(
      claims.sessionId,
      idempotencyKey,
      operation,
      result,
      200,
    );
    return result;
  }

  claimTask(
    claims: SessionClaims,
    idempotencyKey?: string,
  ): ClaimResult | null {
    const operation = "task.claim";
    const cached = this.getIdempotent<ClaimResult | null>(
      claims.sessionId,
      idempotencyKey,
      operation,
    );
    if (cached.found) {
      return cached.value;
    }

    const mission = this.getMission(claims.missionId);
    if (mission.status !== "active") {
      throw conflict("Mission is not accepting work");
    }
    const session = this.getSession(claims.sessionId);
    const candidates = this.database.raw
      .prepare(
        `SELECT * FROM tasks
         WHERE mission_id = ? AND status = 'queued'
         ORDER BY priority DESC, created_at ASC`,
      )
      .all(claims.missionId) as unknown as TaskRow[];

    const taskRow = candidates.find((candidate) => {
      const task = mapTask(candidate);
      return (
        (task.assignedRole === null || task.assignedRole === session.role) &&
        task.requiredCapabilities.every((capability) =>
          session.capabilities.includes(capability),
        ) &&
        this.dependenciesComplete(task.dependencies)
      );
    });

    if (taskRow === undefined) {
      this.saveIdempotent(
        claims.sessionId,
        idempotencyKey,
        operation,
        null,
        200,
      );
      return null;
    }

    const task = mapTask(taskRow);
    const at = this.now();
    const atIso = at.toISOString();
    const expiry = new Date(at.getTime() + this.leaseDurationMs).toISOString();
    const leaseId = randomUUID();
    const fencingRow = this.database.raw
      .prepare(
        "SELECT COALESCE(MAX(fencing_token), 0) AS token FROM leases WHERE task_id = ?",
      )
      .get(task.id) as { token: number };
    const fencingToken = fencingRow.token + 1;

    this.database.transaction(() => {
      const update = this.database.raw
        .prepare(
          `UPDATE tasks
           SET status = 'leased', attempt = attempt + 1, updated_at = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(atIso, task.id);
      if (update.changes !== 1) {
        throw conflict("Task was claimed by another session");
      }
      this.database.raw
        .prepare(
          `INSERT INTO leases(
            id, task_id, session_id, fencing_token, status,
            acquired_at, expires_at, heartbeat_at
          ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(
          leaseId,
          task.id,
          claims.sessionId,
          fencingToken,
          atIso,
          expiry,
          atIso,
        );
      this.touchMission(task.missionId, atIso);
      this.events.append({
        missionId: task.missionId,
        actorType: "agent",
        actorId: claims.sessionId,
        type: "task.claimed",
        payload: {
          taskId: task.id,
          leaseId,
          fencingToken,
          attempt: task.attempt + 1,
          expiresAt: expiry,
        },
        createdAt: atIso,
      });
    });

    const result: ClaimResult = {
      task: { ...task, status: "leased", attempt: task.attempt + 1, updatedAt: atIso },
      lease: {
        id: leaseId,
        taskId: task.id,
        sessionId: claims.sessionId,
        fencingToken,
        status: "active",
        acquiredAt: atIso,
        expiresAt: expiry,
        heartbeatAt: atIso,
      },
      checkpoint: this.getLatestCheckpoint(task.id),
    };
    this.saveIdempotent(
      claims.sessionId,
      idempotencyKey,
      operation,
      result,
      200,
    );
    return result;
  }

  checkpointTask(
    claims: SessionClaims,
    taskId: string,
    input: CheckpointInput,
    idempotencyKey?: string,
  ): Checkpoint {
    const operation = `task.checkpoint:${taskId}`;
    const cached = this.getIdempotent<Checkpoint>(
      claims.sessionId,
      idempotencyKey,
      operation,
    );
    if (cached.found) {
      return cached.value;
    }

    const task = this.getTask(taskId);
    this.assertMissionScope(claims, task.missionId);
    this.assertLease(
      claims.sessionId,
      taskId,
      input.leaseId,
      input.fencingToken,
    );
    this.validateArtifactReferences(task.missionId, input.artifactIds);

    const checkpoint: Checkpoint = {
      id: randomUUID(),
      taskId,
      sessionId: claims.sessionId,
      leaseId: input.leaseId,
      summary: input.summary,
      nextAction: input.nextAction,
      decisions: input.decisions,
      artifactIds: input.artifactIds,
      opaqueState: input.opaqueState,
      createdAt: this.timestamp(),
    };
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO checkpoints(
            id, task_id, session_id, lease_id, summary, next_action,
            decisions_json, artifacts_json, opaque_state_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          checkpoint.id,
          taskId,
          claims.sessionId,
          checkpoint.leaseId,
          checkpoint.summary,
          checkpoint.nextAction,
          JSON.stringify(checkpoint.decisions),
          JSON.stringify(checkpoint.artifactIds),
          checkpoint.opaqueState === null
            ? null
            : JSON.stringify(checkpoint.opaqueState),
          checkpoint.createdAt,
        );
      this.database.raw
        .prepare(
          "UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?",
        )
        .run(checkpoint.createdAt, taskId);
      this.touchMission(task.missionId, checkpoint.createdAt);
      this.events.append({
        missionId: task.missionId,
        actorType: "agent",
        actorId: claims.sessionId,
        type: "task.checkpointed",
        payload: {
          taskId,
          checkpointId: checkpoint.id,
          leaseId: checkpoint.leaseId,
          summary: checkpoint.summary,
          nextAction: checkpoint.nextAction,
          decisions: checkpoint.decisions,
          artifactIds: checkpoint.artifactIds,
        },
        createdAt: checkpoint.createdAt,
      });
    });
    this.saveIdempotent(
      claims.sessionId,
      idempotencyKey,
      operation,
      checkpoint,
      201,
    );
    return checkpoint;
  }

  getLatestCheckpoint(taskId: string): Checkpoint | null {
    const row = this.database.raw
      .prepare(
        "SELECT * FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(taskId) as unknown as CheckpointRow | undefined;
    return row === undefined ? null : mapCheckpoint(row);
  }

  completeTask(
    claims: SessionClaims,
    taskId: string,
    input: CompleteTaskInput,
    idempotencyKey?: string,
  ): Task {
    const operation = `task.complete:${taskId}`;
    const cached = this.getIdempotent<Task>(
      claims.sessionId,
      idempotencyKey,
      operation,
    );
    if (cached.found) {
      return cached.value;
    }

    const task = this.getTask(taskId);
    this.assertMissionScope(claims, task.missionId);
    this.assertLease(
      claims.sessionId,
      taskId,
      input.leaseId,
      input.fencingToken,
    );
    const at = this.timestamp();

    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `UPDATE leases SET status = 'completed', heartbeat_at = ?
           WHERE id = ? AND status = 'active'`,
        )
        .run(at, input.leaseId);
      this.database.raw
        .prepare(
          `UPDATE tasks SET status = 'completed', result_json = ?,
           completed_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(JSON.stringify(input.result), at, at, taskId);
      this.touchMission(task.missionId, at);
      this.events.append({
        missionId: task.missionId,
        actorType: "agent",
        actorId: claims.sessionId,
        type: "task.completed",
        payload: {
          taskId,
          leaseId: input.leaseId,
          fencingToken: input.fencingToken,
          result: input.result,
        },
        createdAt: at,
      });
      this.maybeCompleteMission(task.missionId, at);
    });

    const result: Task = {
      ...task,
      status: "completed",
      result: input.result,
      completedAt: at,
      updatedAt: at,
    };
    this.saveIdempotent(
      claims.sessionId,
      idempotencyKey,
      operation,
      result,
      200,
    );
    return result;
  }

  failTask(
    claims: SessionClaims,
    taskId: string,
    input: FailTaskInput,
    idempotencyKey?: string,
  ): Task {
    const operation = `task.fail:${taskId}`;
    const cached = this.getIdempotent<Task>(
      claims.sessionId,
      idempotencyKey,
      operation,
    );
    if (cached.found) {
      return cached.value;
    }

    const task = this.getTask(taskId);
    this.assertMissionScope(claims, task.missionId);
    this.assertLease(
      claims.sessionId,
      taskId,
      input.leaseId,
      input.fencingToken,
    );
    const requeue = input.retryable && task.attempt < task.maxAttempts;
    const nextStatus: Task["status"] = requeue ? "queued" : "failed";
    const at = this.timestamp();

    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `UPDATE leases SET status = 'released', heartbeat_at = ?
           WHERE id = ?`,
        )
        .run(at, input.leaseId);
      this.database.raw
        .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
        .run(nextStatus, at, taskId);
      this.touchMission(task.missionId, at);
      this.events.append({
        missionId: task.missionId,
        actorType: "agent",
        actorId: claims.sessionId,
        type: requeue ? "task.requeued" : "task.failed",
        payload: {
          taskId,
          leaseId: input.leaseId,
          fencingToken: input.fencingToken,
          reason: input.reason,
          retryable: input.retryable,
          attempt: task.attempt,
        },
        createdAt: at,
      });
      if (!requeue) {
        this.failMissionFromTask(task.missionId, taskId, at);
      }
    });

    const result = { ...task, status: nextStatus, updatedAt: at };
    this.saveIdempotent(
      claims.sessionId,
      idempotencyKey,
      operation,
      result,
      200,
    );
    return result;
  }

  sendMessage(
    claims: SessionClaims,
    input: SendMessageInput,
    idempotencyKey?: string,
  ): RelayMessage {
    const operation = "message.send";
    const cached = this.getIdempotent<RelayMessage>(
      claims.sessionId,
      idempotencyKey,
      operation,
    );
    if (cached.found) {
      return cached.value;
    }

    if (input.toSessionId !== null) {
      const target = this.getSession(input.toSessionId);
      this.assertMissionScope(claims, target.missionId);
    }
    if (input.replyToId !== null) {
      const reply = this.getMessage(input.replyToId);
      this.assertMissionScope(claims, reply.missionId);
    }
    this.validateArtifactReferences(claims.missionId, input.artifactIds);

    const message: RelayMessage = {
      id: randomUUID(),
      missionId: claims.missionId,
      senderSessionId: claims.sessionId,
      toSessionId: input.toSessionId,
      toRole: input.toRole,
      intent: input.intent,
      subject: input.subject,
      content: input.content,
      priority: input.priority,
      correlationId: input.correlationId,
      replyToId: input.replyToId,
      artifactIds: input.artifactIds,
      createdAt: this.timestamp(),
      acknowledgedAt: null,
    };
    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO messages(
            id, mission_id, sender_session_id, to_session_id, to_role, intent,
            subject, content, priority, correlation_id, reply_to_id,
            artifacts_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          message.id,
          message.missionId,
          message.senderSessionId,
          message.toSessionId,
          message.toRole,
          message.intent,
          message.subject,
          message.content,
          message.priority,
          message.correlationId,
          message.replyToId,
          JSON.stringify(message.artifactIds),
          message.createdAt,
        );
      this.touchMission(message.missionId, message.createdAt);
      this.events.append({
        missionId: message.missionId,
        actorType: "agent",
        actorId: claims.sessionId,
        type: "message.sent",
        payload: {
          messageId: message.id,
          toSessionId: message.toSessionId,
          toRole: message.toRole,
          intent: message.intent,
          subject: message.subject,
          priority: message.priority,
          correlationId: message.correlationId,
          replyToId: message.replyToId,
          artifactIds: message.artifactIds,
        },
        createdAt: message.createdAt,
      });
    });
    this.saveIdempotent(
      claims.sessionId,
      idempotencyKey,
      operation,
      message,
      201,
    );
    return message;
  }

  listInbox(claims: SessionClaims, includeAcknowledged = false): RelayMessage[] {
    const rows = this.database.raw
      .prepare(
        `SELECT m.*, a.acknowledged_at
         FROM messages m
         LEFT JOIN message_acknowledgements a
           ON a.message_id = m.id AND a.session_id = ?
         WHERE m.mission_id = ?
           AND m.sender_session_id != ?
           AND (
             m.to_session_id = ?
             OR m.to_role = ?
             OR (m.to_session_id IS NULL AND m.to_role IS NULL)
           )
           AND (? = 1 OR a.acknowledged_at IS NULL)
         ORDER BY m.priority DESC, m.created_at ASC`,
      )
      .all(
        claims.sessionId,
        claims.missionId,
        claims.sessionId,
        claims.sessionId,
        claims.role,
        includeAcknowledged ? 1 : 0,
      ) as unknown as MessageRow[];
    return rows.map(mapMessage);
  }

  acknowledgeMessage(
    claims: SessionClaims,
    messageId: string,
    idempotencyKey?: string,
  ): RelayMessage {
    const operation = `message.ack:${messageId}`;
    const cached = this.getIdempotent<RelayMessage>(
      claims.sessionId,
      idempotencyKey,
      operation,
    );
    if (cached.found) {
      return cached.value;
    }
    const visible = this.listInbox(claims, true).find(
      (message) => message.id === messageId,
    );
    if (visible === undefined) {
      throw forbidden("Message is not addressed to this session");
    }
    const at = this.timestamp();
    this.database.raw
      .prepare(
        `INSERT INTO message_acknowledgements(
          message_id, session_id, acknowledged_at
        ) VALUES (?, ?, ?)
        ON CONFLICT(message_id, session_id)
        DO UPDATE SET acknowledged_at = excluded.acknowledged_at`,
      )
      .run(messageId, claims.sessionId, at);
    const result = { ...visible, acknowledgedAt: at };
    this.saveIdempotent(
      claims.sessionId,
      idempotencyKey,
      operation,
      result,
      200,
    );
    return result;
  }

  listMessages(missionId: string): RelayMessage[] {
    const rows = this.database.raw
      .prepare(
        `SELECT m.*, NULL AS acknowledged_at
         FROM messages m WHERE mission_id = ?
         ORDER BY priority DESC, created_at DESC`,
      )
      .all(missionId) as unknown as MessageRow[];
    return rows.map(mapMessage);
  }

  getMessage(messageId: string): RelayMessage {
    const row = this.database.raw
      .prepare(
        "SELECT m.*, NULL AS acknowledged_at FROM messages m WHERE id = ?",
      )
      .get(messageId) as unknown as MessageRow | undefined;
    if (row === undefined) {
      throw notFound("Message", messageId);
    }
    return mapMessage(row);
  }

  createArtifact(
    claims: SessionClaims,
    input: CreateArtifactInput,
    idempotencyKey?: string,
  ): Artifact {
    const operation = "artifact.create";
    const cached = this.getIdempotent<Artifact>(
      claims.sessionId,
      idempotencyKey,
      operation,
    );
    if (cached.found) {
      return cached.value;
    }
    if (input.taskId !== null) {
      const task = this.getTask(input.taskId);
      this.assertMissionScope(claims, task.missionId);
    }
    const content = Buffer.from(input.contentBase64, "base64");
    if (content.length === 0 || content.length > 10 * 1024 * 1024) {
      throw new RelayError(
        413,
        "ARTIFACT_SIZE",
        "Artifact must be between 1 byte and 10 MiB",
      );
    }
    const digest = sha256(content);
    const artifactDirectory = join(this.dataDirectory, "artifacts", digest.slice(0, 2));
    mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
    const storagePath = join(artifactDirectory, digest);
    if (!existsSync(storagePath)) {
      const temporaryPath = `${storagePath}.${randomUUID()}.tmp`;
      writeFileSync(temporaryPath, content, { mode: 0o600 });
      renameSync(temporaryPath, storagePath);
    }
    const artifact: Artifact = {
      id: randomUUID(),
      missionId: claims.missionId,
      taskId: input.taskId,
      creatorSessionId: claims.sessionId,
      name: input.name,
      mimeType: input.mimeType,
      sizeBytes: content.length,
      sha256: digest,
      createdAt: this.timestamp(),
      metadata: input.metadata,
    };

    this.database.transaction(() => {
      this.database.raw
        .prepare(
          `INSERT INTO artifacts(
            id, mission_id, task_id, creator_session_id, name, mime_type,
            size_bytes, sha256, storage_path, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          artifact.id,
          artifact.missionId,
          artifact.taskId,
          artifact.creatorSessionId,
          artifact.name,
          artifact.mimeType,
          artifact.sizeBytes,
          artifact.sha256,
          storagePath,
          JSON.stringify(artifact.metadata),
          artifact.createdAt,
        );
      this.events.append({
        missionId: claims.missionId,
        actorType: "agent",
        actorId: claims.sessionId,
        type: "artifact.published",
        payload: {
          artifactId: artifact.id,
          taskId: artifact.taskId,
          name: artifact.name,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256,
        },
        createdAt: artifact.createdAt,
      });
    });
    this.saveIdempotent(
      claims.sessionId,
      idempotencyKey,
      operation,
      artifact,
      201,
    );
    return artifact;
  }

  listArtifacts(missionId: string): Artifact[] {
    const rows = this.database.raw
      .prepare(
        "SELECT * FROM artifacts WHERE mission_id = ? ORDER BY created_at DESC",
      )
      .all(missionId) as unknown as ArtifactRow[];
    return rows.map(mapArtifact);
  }

  readArtifact(
    claims: SessionClaims,
    artifactId: string,
  ): { artifact: Artifact; content: Buffer } {
    const row = this.database.raw
      .prepare("SELECT * FROM artifacts WHERE id = ?")
      .get(artifactId) as unknown as ArtifactRow | undefined;
    if (row === undefined) {
      throw notFound("Artifact", artifactId);
    }
    this.assertMissionScope(claims, row.mission_id);
    return { artifact: mapArtifact(row), content: readFileSync(row.storage_path) };
  }

  leaveSession(claims: SessionClaims): AgentSession {
    const session = this.getSession(claims.sessionId);
    const at = this.timestamp();
    this.database.transaction(() => {
      this.database.raw
        .prepare("UPDATE sessions SET status = 'left' WHERE id = ?")
        .run(claims.sessionId);
      const activeLeases = this.database.raw
        .prepare(
          "SELECT * FROM leases WHERE session_id = ? AND status = 'active'",
        )
        .all(claims.sessionId) as unknown as LeaseRow[];
      for (const lease of activeLeases) {
        this.releaseLeaseForRecovery(lease, at, "session.left");
      }
      this.events.append({
        missionId: claims.missionId,
        actorType: "agent",
        actorId: claims.sessionId,
        type: "session.left",
        payload: { sessionId: claims.sessionId },
        createdAt: at,
      });
    });
    return { ...session, status: "left" };
  }

  recover(now = this.now()): RecoveryReport {
    const at = now.toISOString();
    const cutoff = new Date(
      now.getTime() - this.heartbeatTimeoutMs,
    ).toISOString();
    const report: RecoveryReport = {
      lostSessions: [],
      requeuedTasks: [],
      failedTasks: [],
      expiredLeases: [],
    };

    this.database.transaction(() => {
      const lostSessions = this.database.raw
        .prepare(
          `SELECT id, mission_id FROM sessions
           WHERE status = 'active'
             AND (last_heartbeat_at < ? OR expires_at <= ?)`,
        )
        .all(cutoff, at) as unknown as Array<{
        id: string;
        mission_id: string;
      }>;

      for (const session of lostSessions) {
        this.database.raw
          .prepare("UPDATE sessions SET status = 'lost' WHERE id = ?")
          .run(session.id);
        report.lostSessions.push(session.id);
        this.events.append({
          missionId: session.mission_id,
          actorType: "system",
          actorId: "recovery",
          type: "session.lost",
          payload: {
            sessionId: session.id,
            detectedAt: at,
            heartbeatCutoff: cutoff,
          },
          createdAt: at,
        });
      }

      const expiredLeases = this.database.raw
        .prepare(
          `SELECT l.* FROM leases l
           JOIN sessions s ON s.id = l.session_id
           WHERE l.status = 'active'
             AND (l.expires_at <= ? OR s.status != 'active')`,
        )
        .all(at) as unknown as LeaseRow[];
      for (const lease of expiredLeases) {
        const current = this.database.raw
          .prepare("SELECT status FROM leases WHERE id = ?")
          .get(lease.id) as { status: Lease["status"] } | undefined;
        if (current?.status !== "active") {
          continue;
        }
        const outcome = this.releaseLeaseForRecovery(
          lease,
          at,
          "lease.expired",
        );
        report.expiredLeases.push(lease.id);
        if (outcome === "queued") {
          report.requeuedTasks.push(lease.task_id);
        } else {
          report.failedTasks.push(lease.task_id);
        }
      }
    });
    return report;
  }

  getMissionSnapshot(
    missionId: string,
    sessionId?: string,
  ): MissionSnapshot {
    const mission = this.getMission(missionId);
    const eventRow = this.database.raw
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM relay_events WHERE mission_id = ?",
      )
      .get(missionId) as { sequence: number };
    const messages =
      sessionId === undefined
        ? this.listMessages(missionId)
        : this.listInbox(
            {
              ...(this.getSessionClaimsView(sessionId)),
            },
            true,
          );
    return {
      mission,
      sessions: this.listSessions(missionId),
      tasks: this.listTasks(missionId),
      messages,
      artifacts: this.listArtifacts(missionId),
      eventSequence: eventRow.sequence,
    };
  }

  getOverview(): {
    counts: {
      missions: number;
      activeMissions: number;
      activeSessions: number;
      queuedTasks: number;
      runningTasks: number;
      blockers: number;
      recoveries: number;
    };
    missions: ReturnType<RelayRuntime["listMissions"]>;
    recentEvents: ReturnType<EventStore["listRecent"]>;
    chain: ReturnType<EventStore["verifyAll"]>;
  } {
    const scalar = (sql: string): number => {
      const row = this.database.raw.prepare(sql).get() as { count: number };
      return row.count;
    };
    return {
      counts: {
        missions: scalar("SELECT COUNT(*) AS count FROM missions"),
        activeMissions: scalar(
          "SELECT COUNT(*) AS count FROM missions WHERE status = 'active'",
        ),
        activeSessions: scalar(
          "SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'",
        ),
        queuedTasks: scalar(
          "SELECT COUNT(*) AS count FROM tasks WHERE status = 'queued'",
        ),
        runningTasks: scalar(
          "SELECT COUNT(*) AS count FROM tasks WHERE status IN ('leased', 'running')",
        ),
        blockers: scalar(
          "SELECT COUNT(*) AS count FROM messages WHERE intent = 'blocker'",
        ),
        recoveries: scalar(
          "SELECT COUNT(*) AS count FROM relay_events WHERE type IN ('session.lost', 'task.recovered')",
        ),
      },
      missions: this.listMissions(),
      recentEvents: this.events.listRecent(20),
      chain: this.events.verifyAll(),
    };
  }

  getIdempotent<T>(
    actorId: string,
    key: string | undefined,
    operation: string,
  ): { found: true; value: T } | { found: false } {
    if (key === undefined || key.length === 0) {
      return { found: false };
    }
    const row = this.database.raw
      .prepare(
        `SELECT operation, response_json, status_code
         FROM idempotency_records
         WHERE actor_id = ? AND idempotency_key = ?`,
      )
      .get(actorId, key) as unknown as IdempotencyRow | undefined;
    if (row === undefined) {
      return { found: false };
    }
    if (row.operation !== operation) {
      throw conflict("Idempotency key was already used for another operation");
    }
    return { found: true, value: JSON.parse(row.response_json) as T };
  }

  saveIdempotent<T>(
    actorId: string,
    key: string | undefined,
    operation: string,
    response: T,
    statusCode: number,
  ): void {
    if (key === undefined || key.length === 0) {
      return;
    }
    try {
      this.database.raw
        .prepare(
          `INSERT INTO idempotency_records(
            actor_id, idempotency_key, operation, response_json,
            status_code, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          actorId,
          key,
          operation,
          JSON.stringify(response),
          statusCode,
          this.timestamp(),
        );
    } catch (error) {
      const existing = this.getIdempotent<T>(actorId, key, operation);
      if (!existing.found) {
        throw error;
      }
    }
  }

  private validateTaskReferences(
    missionId: string,
    input: CreateTaskInput,
  ): void {
    const references = [
      ...(input.parentTaskId === null ? [] : [input.parentTaskId]),
      ...input.dependencies,
    ];
    for (const taskId of references) {
      const task = this.getTask(taskId);
      if (task.missionId !== missionId) {
        throw forbidden("Task references cannot cross mission boundaries");
      }
    }
    if (new Set(input.dependencies).size !== input.dependencies.length) {
      throw conflict("Task dependencies must be unique");
    }
  }

  private validateArtifactReferences(
    missionId: string,
    artifactIds: string[],
  ): void {
    for (const artifactId of artifactIds) {
      const row = this.database.raw
        .prepare("SELECT mission_id FROM artifacts WHERE id = ?")
        .get(artifactId) as { mission_id: string } | undefined;
      if (row === undefined) {
        throw notFound("Artifact", artifactId);
      }
      if (row.mission_id !== missionId) {
        throw forbidden("Artifact belongs to another mission");
      }
    }
  }

  private dependenciesComplete(dependencies: string[]): boolean {
    return dependencies.every((taskId) => {
      const row = this.database.raw
        .prepare("SELECT status FROM tasks WHERE id = ?")
        .get(taskId) as { status: Task["status"] } | undefined;
      return row?.status === "completed";
    });
  }

  private assertLease(
    sessionId: string,
    taskId: string,
    leaseId: string,
    fencingToken: number,
  ): Lease {
    const row = this.database.raw
      .prepare("SELECT * FROM leases WHERE id = ?")
      .get(leaseId) as unknown as LeaseRow | undefined;
    if (row === undefined) {
      throw notFound("Lease", leaseId);
    }
    if (
      row.task_id !== taskId ||
      row.session_id !== sessionId ||
      row.status !== "active" ||
      row.fencing_token !== fencingToken
    ) {
      throw conflict("Lease is stale or does not own this task", {
        expectedTaskId: taskId,
        expectedSessionId: sessionId,
        receivedFencingToken: fencingToken,
      });
    }
    if (new Date(row.expires_at).getTime() <= this.now().getTime()) {
      throw conflict("Lease has expired");
    }
    return mapLease(row);
  }

  private assertMissionScope(claims: SessionClaims, missionId: string): void {
    if (claims.missionId !== missionId) {
      throw forbidden("Session is scoped to another mission");
    }
  }

  private countInbox(claims: SessionClaims): number {
    return this.listInbox(claims, false).length;
  }

  private getSessionClaimsView(sessionId: string): SessionClaims {
    const session = this.getSession(sessionId);
    const row = this.database.raw
      .prepare("SELECT token_jti FROM sessions WHERE id = ?")
      .get(sessionId) as { token_jti: string };
    return {
      type: "agent-session",
      sessionId,
      agentId: session.agentId,
      missionId: session.missionId,
      role: session.role,
      capabilities: session.capabilities,
      jti: row.token_jti,
      issuedAt: Math.floor(new Date(session.joinedAt).getTime() / 1000),
      expiresAt: Math.floor(new Date(session.expiresAt).getTime() / 1000),
    };
  }

  private releaseLeaseForRecovery(
    lease: LeaseRow,
    at: string,
    reason: string,
  ): "queued" | "failed" {
    const task = this.getTask(lease.task_id);
    const nextStatus: "queued" | "failed" =
      task.attempt >= task.maxAttempts ? "failed" : "queued";
    this.database.raw
      .prepare("UPDATE leases SET status = 'expired', heartbeat_at = ? WHERE id = ?")
      .run(at, lease.id);
    this.database.raw
      .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
      .run(nextStatus, at, lease.task_id);
    this.events.append({
      missionId: task.missionId,
      actorType: "system",
      actorId: "recovery",
      type: nextStatus === "queued" ? "task.recovered" : "task.failed",
      payload: {
        taskId: task.id,
        leaseId: lease.id,
        priorSessionId: lease.session_id,
        fencingToken: lease.fencing_token,
        reason,
        attempt: task.attempt,
        maxAttempts: task.maxAttempts,
        checkpointId: this.getLatestCheckpoint(task.id)?.id ?? null,
      },
      createdAt: at,
    });
    if (nextStatus === "failed") {
      this.failMissionFromTask(task.missionId, task.id, at);
    }
    return nextStatus;
  }

  private maybeCompleteMission(missionId: string, at: string): void {
    if (this.getMission(missionId).status !== "active") {
      return;
    }
    const counts = this.database.raw
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
         FROM tasks WHERE mission_id = ?`,
      )
      .get(missionId) as { total: number; completed: number | null };
    if (counts.total > 0 && counts.completed === counts.total) {
      this.database.raw
        .prepare(
          "UPDATE missions SET status = 'completed', updated_at = ? WHERE id = ?",
        )
        .run(at, missionId);
      this.events.append({
        missionId,
        actorType: "system",
        actorId: "scheduler",
        type: "mission.completed",
        payload: { taskCount: counts.total },
        createdAt: at,
      });
    }
  }

  private failMissionFromTask(
    missionId: string,
    failedTaskId: string,
    at: string,
  ): void {
    const mission = this.getMission(missionId);
    if (["completed", "failed", "cancelled"].includes(mission.status)) {
      return;
    }
    this.cancelOpenTasks(missionId, at, "dependency_failed");
    this.database.raw
      .prepare(
        "UPDATE missions SET status = 'failed', updated_at = ? WHERE id = ?",
      )
      .run(at, missionId);
    this.events.append({
      missionId,
      actorType: "system",
      actorId: "scheduler",
      type: "mission.failed",
      payload: {
        failedTaskId,
        priorStatus: mission.status,
      },
      createdAt: at,
    });
  }

  private cancelOpenTasks(
    missionId: string,
    at: string,
    reason: string,
  ): void {
    const tasks = this.database.raw
      .prepare(
        `SELECT * FROM tasks
         WHERE mission_id = ? AND status IN ('queued', 'leased', 'running')`,
      )
      .all(missionId) as unknown as TaskRow[];
    for (const row of tasks) {
      this.database.raw
        .prepare(
          `UPDATE leases SET status = 'released', heartbeat_at = ?
           WHERE task_id = ? AND status = 'active'`,
        )
        .run(at, row.id);
      this.database.raw
        .prepare(
          `UPDATE tasks SET status = 'cancelled', updated_at = ?
           WHERE id = ?`,
        )
        .run(at, row.id);
      this.events.append({
        missionId,
        actorType: "system",
        actorId: "scheduler",
        type: "task.cancelled",
        payload: {
          taskId: row.id,
          priorStatus: row.status,
          reason,
        },
        createdAt: at,
      });
    }
  }

  private touchMission(missionId: string, at: string): void {
    this.database.raw
      .prepare("UPDATE missions SET updated_at = ? WHERE id = ?")
      .run(at, missionId);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

const sessionSelect = `
  SELECT s.*, a.name AS agent_name, a.provider AS provider
  FROM sessions s JOIN agents a ON a.id = s.agent_id
`;

function mapAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    defaultModel: row.default_model,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
  };
}

function mapConnectionTicket(row: ConnectionTicketRow): ConnectionTicket {
  return {
    id: row.id,
    missionId: row.mission_id,
    agentId: row.agent_id,
    model: row.model,
    role: row.role,
    capabilities: parseJson<string[]>(row.capabilities_json, []),
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function mapMission(row: MissionRow): Mission {
  return {
    id: row.id,
    title: row.title,
    objective: row.objective,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSession(row: SessionRow): AgentSession {
  return {
    id: row.id,
    missionId: row.mission_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    provider: row.provider,
    model: row.model,
    role: row.role,
    capabilities: parseJson<string[]>(row.capabilities_json, []),
    status: row.status,
    joinedAt: row.joined_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    expiresAt: row.expires_at,
    recoveryFromSessionId: row.recovery_from_session_id,
  };
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    missionId: row.mission_id,
    parentTaskId: row.parent_task_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    requiredCapabilities: parseJson<string[]>(row.requirements_json, []),
    dependencies: parseJson<string[]>(row.dependencies_json, []),
    assignedRole: row.assigned_role,
    maxAttempts: row.max_attempts,
    attempt: row.attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    result: parseJson<Record<string, unknown> | null>(row.result_json, null),
  };
}

function mapLease(row: LeaseRow): Lease {
  return {
    id: row.id,
    taskId: row.task_id,
    sessionId: row.session_id,
    fencingToken: row.fencing_token,
    status: row.status,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at,
  };
}

function mapCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    id: row.id,
    taskId: row.task_id,
    sessionId: row.session_id,
    leaseId: row.lease_id,
    summary: row.summary,
    nextAction: row.next_action,
    decisions: parseJson<Checkpoint["decisions"]>(row.decisions_json, []),
    artifactIds: parseJson<string[]>(row.artifacts_json, []),
    opaqueState: parseJson<Record<string, unknown> | null>(
      row.opaque_state_json,
      null,
    ),
    createdAt: row.created_at,
  };
}

function mapMessage(row: MessageRow): RelayMessage {
  return {
    id: row.id,
    missionId: row.mission_id,
    senderSessionId: row.sender_session_id,
    toSessionId: row.to_session_id,
    toRole: row.to_role,
    intent: row.intent,
    subject: row.subject,
    content: row.content,
    priority: row.priority,
    correlationId: row.correlation_id,
    replyToId: row.reply_to_id,
    artifactIds: parseJson<string[]>(row.artifacts_json, []),
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
  };
}

function mapArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    missionId: row.mission_id,
    taskId: row.task_id,
    creatorSessionId: row.creator_session_id,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
  };
}
