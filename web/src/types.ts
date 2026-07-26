export type MissionStatus =
  | "draft"
  | "active"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface Mission {
  id: string;
  title: string;
  objective: string;
  status: MissionStatus;
  createdAt: string;
  updatedAt: string;
  taskCount?: number;
  activeSessions?: number;
}

export interface Agent {
  id: string;
  name: string;
  provider: string;
  defaultModel: string;
  description: string;
  status: "active" | "revoked";
  createdAt: string;
}

export interface Session {
  id: string;
  missionId: string;
  agentId: string;
  agentName: string;
  provider: string;
  model: string;
  role: string;
  capabilities: string[];
  status: "active" | "lost" | "left" | "revoked";
  lastHeartbeatAt: string;
  recoveryFromSessionId: string | null;
}

export interface Task {
  id: string;
  missionId: string;
  title: string;
  description: string;
  status:
    | "queued"
    | "leased"
    | "running"
    | "completed"
    | "failed"
    | "cancelled";
  priority: number;
  requiredCapabilities: string[];
  assignedRole: string | null;
  attempt: number;
  maxAttempts: number;
  updatedAt: string;
}

export interface RelayMessage {
  id: string;
  senderSessionId: string;
  intent:
    | "inform"
    | "request"
    | "response"
    | "challenge"
    | "decision"
    | "handoff"
    | "blocker";
  subject: string;
  priority: number;
  createdAt: string;
}

export interface Artifact {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export interface Event {
  sequence: number;
  id: string;
  missionId: string | null;
  actorType: "admin" | "agent" | "system";
  actorId: string;
  type: string;
  payload: Record<string, unknown>;
  hash: string;
  createdAt: string;
}

export interface MissionSnapshot {
  mission: Mission;
  sessions: Session[];
  tasks: Task[];
  messages: RelayMessage[];
  artifacts: Artifact[];
  eventSequence: number;
}

export interface Overview {
  counts: {
    missions: number;
    activeMissions: number;
    activeSessions: number;
    queuedTasks: number;
    runningTasks: number;
    blockers: number;
    recoveries: number;
  };
  missions: Mission[];
  recentEvents: Event[];
  chain: {
    valid: boolean;
    checked: number;
    reason: string | null;
    headHash: string;
  };
}
