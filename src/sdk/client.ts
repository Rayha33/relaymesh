import type {
  HeartbeatResult,
  JoinedSession,
  RelayRuntime,
} from "../core/runtime.js";
import type {
  CheckpointInput,
  CompleteTaskInput,
  CreateAgentInput,
  CreateArtifactInput,
  CreateMissionInput,
  CreateTaskInput,
  FailTaskInput,
  JoinSessionInput,
  SendMessageInput,
} from "../core/schemas.js";
import type {
  Agent,
  AgentSession,
  Artifact,
  Checkpoint,
  ClaimResult,
  Mission,
  MissionSnapshot,
  RecoveryReport,
  RelayMessage,
  Task,
} from "../core/types.js";

export class RelayApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details: unknown,
  ) {
    super(message);
    this.name = "RelayApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface RelayClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

type Overview = ReturnType<RelayRuntime["getOverview"]>;

class HttpClient {
  protected readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: RelayClientOptions) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:4317").replace(
      /\/$/,
      "",
    );
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  protected async request<T>(
    path: string,
    init: RequestInit,
    authHeaders: Record<string, string>,
    idempotent = false,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(authHeaders)) {
      headers.set(key, value);
    }
    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (idempotent && !headers.has("idempotency-key")) {
      headers.set("idempotency-key", crypto.randomUUID());
    }
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    if (!response.ok) {
      const error = isApiError(payload) ? payload.error : null;
      throw new RelayApiError(
        response.status,
        error?.code ?? "HTTP_ERROR",
        error?.message ?? `RelayMesh returned HTTP ${response.status}`,
        error?.details ?? payload,
      );
    }
    return payload as T;
  }
}

export class RelayAdminClient extends HttpClient {
  constructor(
    private readonly adminToken: string,
    options: RelayClientOptions = {},
  ) {
    super(options);
  }

  private get auth(): Record<string, string> {
    return { authorization: `Bearer ${this.adminToken}` };
  }

  authenticate(): Promise<{ authenticated: true }> {
    return this.request("/api/v1/admin/auth", { method: "GET" }, this.auth);
  }

  overview(): Promise<Overview> {
    return this.request("/api/v1/admin/overview", { method: "GET" }, this.auth);
  }

  listAgents(): Promise<Agent[]> {
    return this.request("/api/v1/agents", { method: "GET" }, this.auth);
  }

  createAgent(
    input: CreateAgentInput,
  ): Promise<{ agent: Agent; agentKey: string }> {
    return this.request(
      "/api/v1/agents",
      { method: "POST", body: JSON.stringify(input) },
      this.auth,
    );
  }

  revokeAgent(agentId: string): Promise<Agent> {
    return this.request(
      `/api/v1/agents/${agentId}/revoke`,
      { method: "POST" },
      this.auth,
    );
  }

  listMissions(): Promise<
    Array<Mission & { taskCount: number; activeSessions: number }>
  > {
    return this.request("/api/v1/missions", { method: "GET" }, this.auth);
  }

  createMission(input: CreateMissionInput): Promise<Mission> {
    return this.request(
      "/api/v1/missions",
      { method: "POST", body: JSON.stringify(input) },
      this.auth,
    );
  }

  getMission(missionId: string): Promise<MissionSnapshot> {
    return this.request(
      `/api/v1/missions/${missionId}`,
      { method: "GET" },
      this.auth,
    );
  }

  updateMissionStatus(
    missionId: string,
    status: Mission["status"],
  ): Promise<Mission> {
    return this.request(
      `/api/v1/missions/${missionId}`,
      { method: "PATCH", body: JSON.stringify({ status }) },
      this.auth,
    );
  }

  createTask(missionId: string, input: CreateTaskInput): Promise<Task> {
    return this.request(
      `/api/v1/missions/${missionId}/tasks`,
      { method: "POST", body: JSON.stringify(input) },
      this.auth,
    );
  }

  recover(): Promise<RecoveryReport> {
    return this.request(
      "/api/v1/admin/recover",
      { method: "POST" },
      this.auth,
    );
  }

  verifyEvents(
    missionId: string,
  ): Promise<{ valid: boolean; checked: number; reason: string | null }> {
    return this.request(
      `/api/v1/missions/${missionId}/events/verify`,
      { method: "GET" },
      this.auth,
    );
  }
}

export class RelayAgentClient extends HttpClient {
  constructor(
    private readonly agentId: string,
    private readonly agentKey: string,
    options: RelayClientOptions = {},
  ) {
    super(options);
  }

  async join(
    missionId: string,
    input: JoinSessionInput,
  ): Promise<{
    joined: JoinedSession;
    session: RelaySessionClient;
  }> {
    const joined = await this.request<JoinedSession>(
      `/api/v1/missions/${missionId}/sessions`,
      { method: "POST", body: JSON.stringify(input) },
      { "x-agent-id": this.agentId, "x-agent-key": this.agentKey },
      true,
    );
    return {
      joined,
      session: new RelaySessionClient(joined.sessionToken, joined.session, {
        baseUrl: this.baseUrl,
      }),
    };
  }
}

export class RelaySessionClient extends HttpClient {
  constructor(
    private readonly sessionToken: string,
    readonly identity: AgentSession,
    options: RelayClientOptions = {},
  ) {
    super(options);
  }

  private get auth(): Record<string, string> {
    return { authorization: `Bearer ${this.sessionToken}` };
  }

  heartbeat(): Promise<HeartbeatResult> {
    return this.request(
      `/api/v1/sessions/${this.identity.id}/heartbeat`,
      { method: "POST" },
      this.auth,
      true,
    );
  }

  claim(): Promise<ClaimResult | null> {
    return this.request(
      `/api/v1/missions/${this.identity.missionId}/tasks/claim`,
      { method: "POST" },
      this.auth,
      true,
    );
  }

  checkpoint(taskId: string, input: CheckpointInput): Promise<Checkpoint> {
    return this.request(
      `/api/v1/tasks/${taskId}/checkpoints`,
      { method: "POST", body: JSON.stringify(input) },
      this.auth,
      true,
    );
  }

  complete(taskId: string, input: CompleteTaskInput): Promise<Task> {
    return this.request(
      `/api/v1/tasks/${taskId}/complete`,
      { method: "POST", body: JSON.stringify(input) },
      this.auth,
      true,
    );
  }

  fail(taskId: string, input: FailTaskInput): Promise<Task> {
    return this.request(
      `/api/v1/tasks/${taskId}/fail`,
      { method: "POST", body: JSON.stringify(input) },
      this.auth,
      true,
    );
  }

  sendMessage(input: SendMessageInput): Promise<RelayMessage> {
    return this.request(
      `/api/v1/missions/${this.identity.missionId}/messages`,
      { method: "POST", body: JSON.stringify(input) },
      this.auth,
      true,
    );
  }

  inbox(includeAcknowledged = false): Promise<RelayMessage[]> {
    return this.request(
      `/api/v1/sessions/${this.identity.id}/inbox?all=${String(includeAcknowledged)}`,
      { method: "GET" },
      this.auth,
    );
  }

  acknowledge(messageId: string): Promise<RelayMessage> {
    return this.request(
      `/api/v1/messages/${messageId}/ack`,
      { method: "POST" },
      this.auth,
      true,
    );
  }

  publishArtifact(input: CreateArtifactInput): Promise<Artifact> {
    return this.request(
      `/api/v1/missions/${this.identity.missionId}/artifacts`,
      { method: "POST", body: JSON.stringify(input) },
      this.auth,
      true,
    );
  }

  listArtifacts(): Promise<Artifact[]> {
    return this.request(
      `/api/v1/missions/${this.identity.missionId}/artifacts`,
      { method: "GET" },
      this.auth,
    );
  }

  leave(): Promise<AgentSession> {
    return this.request(
      `/api/v1/sessions/${this.identity.id}/leave`,
      { method: "POST" },
      this.auth,
      true,
    );
  }
}

interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

function isApiError(value: unknown): value is ApiErrorPayload {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return false;
  }
  const error = value.error;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error
  );
}
