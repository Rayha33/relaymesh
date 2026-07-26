export const missionStatuses = [
  "draft",
  "active",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;

export const taskStatuses = [
  "queued",
  "leased",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export const sessionStatuses = [
  "active",
  "lost",
  "left",
  "revoked",
] as const;

export const messageIntents = [
  "inform",
  "request",
  "response",
  "challenge",
  "decision",
  "handoff",
  "blocker",
] as const;

export type MissionStatus = (typeof missionStatuses)[number];
export type TaskStatus = (typeof taskStatuses)[number];
export type SessionStatus = (typeof sessionStatuses)[number];
export type MessageIntent = (typeof messageIntents)[number];

export interface Agent {
  id: string;
  name: string;
  provider: string;
  defaultModel: string;
  description: string;
  status: "active" | "revoked";
  createdAt: string;
}

export interface Mission {
  id: string;
  title: string;
  objective: string;
  status: MissionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSession {
  id: string;
  missionId: string;
  agentId: string;
  agentName: string;
  provider: string;
  model: string;
  role: string;
  capabilities: string[];
  status: SessionStatus;
  joinedAt: string;
  lastHeartbeatAt: string;
  expiresAt: string;
  recoveryFromSessionId: string | null;
}

export interface Task {
  id: string;
  missionId: string;
  parentTaskId: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  requiredCapabilities: string[];
  dependencies: string[];
  assignedRole: string | null;
  maxAttempts: number;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  result: Record<string, unknown> | null;
}

export interface Lease {
  id: string;
  taskId: string;
  sessionId: string;
  fencingToken: number;
  status: "active" | "expired" | "released" | "completed";
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
}

export interface Checkpoint {
  id: string;
  taskId: string;
  sessionId: string;
  leaseId: string;
  summary: string;
  nextAction: string;
  decisions: Array<{ decision: string; rationale?: string | undefined }>;
  artifactIds: string[];
  opaqueState: Record<string, unknown> | null;
  createdAt: string;
}

export interface RelayMessage {
  id: string;
  missionId: string;
  senderSessionId: string;
  toSessionId: string | null;
  toRole: string | null;
  intent: MessageIntent;
  subject: string;
  content: string;
  priority: number;
  correlationId: string | null;
  replyToId: string | null;
  artifactIds: string[];
  createdAt: string;
  acknowledgedAt: string | null;
}

export interface Artifact {
  id: string;
  missionId: string;
  taskId: string | null;
  creatorSessionId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface RelayEvent {
  sequence: number;
  id: string;
  missionId: string | null;
  actorType: "admin" | "agent" | "system";
  actorId: string;
  type: string;
  payload: Record<string, unknown>;
  previousHash: string;
  hash: string;
  signature: string;
  createdAt: string;
}

export interface MissionSnapshot {
  mission: Mission;
  sessions: AgentSession[];
  tasks: Task[];
  messages: RelayMessage[];
  artifacts: Artifact[];
  eventSequence: number;
}

export interface ClaimResult {
  task: Task;
  lease: Lease;
  checkpoint: Checkpoint | null;
}

export interface RecoveryReport {
  lostSessions: string[];
  requeuedTasks: string[];
  failedTasks: string[];
  expiredLeases: string[];
}
