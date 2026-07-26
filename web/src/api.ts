import type {
  Agent,
  Event,
  Mission,
  MissionCapsule,
  MissionResultReport,
  MissionSnapshot,
  Overview,
  Task,
} from "./types";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

let token = sessionStorage.getItem("relaymesh.adminToken") ?? "";

export function setAdminToken(value: string): void {
  token = value;
  if (value.length === 0) {
    sessionStorage.removeItem("relaymesh.adminToken");
  } else {
    sessionStorage.setItem("relaymesh.adminToken", value);
  }
}

export function hasToken(): boolean {
  return token.length > 0;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, { ...init, headers });
  const payload = (await response.json()) as
    | T
    | { error: { code: string; message: string } };
  if (!response.ok) {
    const error =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload
        ? payload.error
        : { code: "HTTP_ERROR", message: `HTTP ${response.status}` };
    throw new ApiError(error.code, error.message, response.status);
  }
  return payload as T;
}

export const api = {
  authenticate: () =>
    request<{ authenticated: true }>("/api/v1/admin/auth"),
  overview: () => request<Overview>("/api/v1/admin/overview"),
  agents: () => request<Agent[]>("/api/v1/agents"),
  createAgent: (input: {
    name: string;
    provider: string;
    defaultModel: string;
    description: string;
  }) =>
    request<{ agent: Agent; agentKey: string }>("/api/v1/agents", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  revokeAgent: (agentId: string) =>
    request<Agent>(`/api/v1/agents/${agentId}/revoke`, { method: "POST" }),
  missions: () => request<Mission[]>("/api/v1/missions"),
  mission: (missionId: string) =>
    request<MissionSnapshot>(`/api/v1/missions/${missionId}`),
  missionResult: (missionId: string) =>
    request<MissionResultReport>(`/api/v1/missions/${missionId}/result`),
  missionCapsule: (missionId: string) =>
    request<MissionCapsule>(`/api/v1/missions/${missionId}/capsule`),
  createMission: (input: { title: string; objective: string }) =>
    request<Mission>("/api/v1/missions", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  createTask: (
    missionId: string,
    input: {
      title: string;
      description: string;
      priority: number;
      requiredCapabilities: string[];
      assignedRole: string | null;
      maxAttempts: number;
      dependencies: string[];
      parentTaskId: null;
    },
  ) =>
    request<Task>(`/api/v1/missions/${missionId}/tasks`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  setMissionStatus: (missionId: string, status: Mission["status"]) =>
    request<Mission>(`/api/v1/missions/${missionId}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  events: (missionId: string) =>
    request<Event[]>(`/api/v1/missions/${missionId}/events`),
  verify: (missionId: string) =>
    request<{
      valid: boolean;
      checked: number;
      reason: string | null;
      headHash: string;
      firstInvalidSequence: number | null;
    }>(`/api/v1/missions/${missionId}/events/verify`),
  recover: () =>
    request<{
      lostSessions: string[];
      requeuedTasks: string[];
      failedTasks: string[];
      expiredLeases: string[];
    }>("/api/v1/admin/recover", { method: "POST" }),
};
