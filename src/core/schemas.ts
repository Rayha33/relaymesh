import { z } from "zod";
import {
  messageIntents,
  missionStatuses,
  taskStatuses,
} from "./types.js";

const identifier = z.string().trim().min(1).max(120);
const shortText = z.string().trim().min(1).max(240);
const longText = z.string().trim().min(1).max(20_000);
const capability = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9*:_-]+(?:\.[a-z0-9*:_-]+)*$/i);

export const createAgentSchema = z.object({
  name: shortText,
  provider: identifier,
  defaultModel: identifier,
  description: z.string().trim().max(1_000).default(""),
});

export const createMissionSchema = z.object({
  title: shortText,
  objective: longText,
});

export const updateMissionSchema = z.object({
  status: z.enum(missionStatuses),
});

export const createTaskSchema = z.object({
  title: shortText,
  description: longText,
  parentTaskId: z.string().uuid().nullable().default(null),
  priority: z.number().int().min(-100).max(100).default(0),
  requiredCapabilities: z.array(capability).max(50).default([]),
  dependencies: z.array(z.string().uuid()).max(100).default([]),
  assignedRole: z.string().trim().min(1).max(80).nullable().default(null),
  maxAttempts: z.number().int().min(1).max(20).default(3),
});

export const updateTaskSchema = z.object({
  status: z.enum(taskStatuses),
});

export const joinSessionSchema = z.object({
  model: identifier,
  role: z.string().trim().min(1).max(80),
  capabilities: z.array(capability).min(1).max(100),
  recoveryFromSessionId: z.string().uuid().nullable().default(null),
});

export const checkpointSchema = z.object({
  leaseId: z.string().uuid(),
  fencingToken: z.number().int().positive(),
  summary: longText,
  nextAction: z.string().trim().max(5_000).default(""),
  decisions: z
    .array(
      z.object({
        decision: z.string().trim().min(1).max(2_000),
        rationale: z.string().trim().max(4_000).optional(),
      }),
    )
    .max(100)
    .default([]),
  artifactIds: z.array(z.string().uuid()).max(100).default([]),
  opaqueState: z.record(z.string(), z.unknown()).nullable().default(null),
});

export const sendMessageSchema = z
  .object({
    toSessionId: z.string().uuid().nullable().default(null),
    toRole: z.string().trim().min(1).max(80).nullable().default(null),
    intent: z.enum(messageIntents),
    subject: shortText,
    content: longText,
    priority: z.number().int().min(-100).max(100).default(0),
    correlationId: z.string().uuid().nullable().default(null),
    replyToId: z.string().uuid().nullable().default(null),
    artifactIds: z.array(z.string().uuid()).max(100).default([]),
  })
  .refine(
    ({ toSessionId, toRole }) => !(toSessionId !== null && toRole !== null),
    "Choose a session or role recipient, not both",
  );

export const completeTaskSchema = z.object({
  leaseId: z.string().uuid(),
  fencingToken: z.number().int().positive(),
  result: z.record(z.string(), z.unknown()).default({}),
});

export const failTaskSchema = z.object({
  leaseId: z.string().uuid(),
  fencingToken: z.number().int().positive(),
  reason: z.string().trim().min(1).max(5_000),
  retryable: z.boolean().default(true),
});

export const createArtifactSchema = z.object({
  taskId: z.string().uuid().nullable().default(null),
  name: shortText,
  mimeType: z.string().trim().min(1).max(160),
  contentBase64: z.string().min(1).max(14_000_000),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type CreateMissionInput = z.infer<typeof createMissionSchema>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type JoinSessionInput = z.infer<typeof joinSessionSchema>;
export type CheckpointInput = z.infer<typeof checkpointSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type CompleteTaskInput = z.infer<typeof completeTaskSchema>;
export type FailTaskInput = z.infer<typeof failTaskSchema>;
export type CreateArtifactInput = z.infer<typeof createArtifactSchema>;
