import {
  executeRelayFunction,
  relayFunctionTools,
} from "../src/sdk/tools.js";
import { RelayAgentClient } from "../src/sdk/client.js";

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | AssistantMessage
  | { role: "tool"; tool_call_id: string; content: string };

const config = {
  modelBaseUrl: required("MODEL_API_BASE", "https://api.deepseek.com"),
  modelApiKey: required("MODEL_API_KEY"),
  model: required("MODEL_NAME"),
  relayUrl: required("RELAYMESH_URL", "http://127.0.0.1:4317"),
  missionId: required("RELAYMESH_MISSION_ID"),
  agentId: required("RELAYMESH_AGENT_ID"),
  agentKey: required("RELAYMESH_AGENT_KEY"),
  role: required("RELAYMESH_ROLE", "worker"),
  capabilities: required("RELAYMESH_CAPABILITIES", "general")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  maxTurns: positiveInteger("RELAYMESH_MAX_TURNS", 32),
};

const agent = new RelayAgentClient(config.agentId, config.agentKey, {
  baseUrl: config.relayUrl,
});
const { joined, session } = await agent.join(config.missionId, {
  model: config.model,
  role: config.role,
  capabilities: config.capabilities,
  recoveryFromSessionId:
    process.env.RELAYMESH_RECOVERY_SESSION_ID?.trim() || null,
});
const heartbeatTimer = setInterval(() => {
  void session.heartbeat().catch((error: unknown) => {
    process.stderr.write(
      `RelayMesh heartbeat failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  });
}, 10_000);
heartbeatTimer.unref();

const initialEnvelope = await session.sync({
  autoClaim: true,
  includeAcknowledged: false,
});
const messages: ChatMessage[] = [
  {
    role: "system",
    content: [
      "You are one worker in a RelayMesh mission shared with other AI model sessions.",
      "RelayMesh is canonical. The runtime already synchronized and claimed at most one task before this model turn.",
      "Call relay_sync again whenever state may have changed.",
      "Checkpoint meaningful progress and before external side effects.",
      "Use durable typed messages for requests, challenges, decisions, handoffs, and blockers.",
      "Complete, fail, or hand off every claimed task with its exact lease ID and fencing token.",
      "Never reuse stale lease data after a reconnect.",
      "Do not invent task IDs, lease IDs, fencing tokens, messages, or artifacts.",
    ].join(" "),
  },
  {
    role: "user",
    content: [
      `Join mission "${joined.snapshot.mission.title}".`,
      "The following RelayMesh v2 envelope is authoritative:",
      JSON.stringify(initialEnvelope),
    ].join("\n"),
  },
];

let taskFinalized = false;
let lastAssistantContent = "";
try {
  for (let turn = 0; turn < config.maxTurns; turn += 1) {
    const assistant = await complete(messages);
    messages.push(assistant);
    if (assistant.content !== null) {
      lastAssistantContent = assistant.content;
    }
    const toolCalls = assistant.tool_calls ?? [];
    if (toolCalls.length === 0) {
      if (assistant.content !== null) {
        process.stdout.write(`${assistant.content}\n`);
      }
      break;
    }

    for (const call of toolCalls) {
      try {
        const args = JSON.parse(call.function.arguments) as unknown;
        const output = await executeRelayFunction(
          session,
          call.function.name,
          args,
        );
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(output),
        });
        taskFinalized ||= [
          "relay_complete_task",
          "relay_fail_task",
          "relay_handoff",
        ].includes(call.function.name);
      } catch (error) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        });
      }
    }
    if (taskFinalized) {
      break;
    }
  }
} finally {
  clearInterval(heartbeatTimer);
  if (!taskFinalized) {
    const finalEnvelope = await session
      .sync({ autoClaim: false, includeAcknowledged: false })
      .catch(() => null);
    if (finalEnvelope?.work) {
      const { task, lease } = finalEnvelope.work;
      await session.handoff(task.id, {
        leaseId: lease.id,
        fencingToken: lease.fencingToken,
        summary:
          lastAssistantContent.slice(0, 20_000) ||
          "The provider worker stopped before producing a terminal task mutation.",
        nextAction:
          "Call relay_sync, inspect this checkpoint, and continue or complete the task.",
        decisions: [],
        artifactIds: [],
        opaqueState: {
          priorModel: config.model,
          reason: "worker_exit",
        },
        targetRole: config.role,
        subject: "Automatic safe handoff after worker exit",
        content:
          "RelayMesh preserved the last model output and released ownership without consuming a failure attempt.",
        priority: 20,
      })
      .catch((error: unknown) => {
        process.stderr.write(
          `RelayMesh automatic handoff failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    }
  }
  await session.leave().catch(() => undefined);
}

async function complete(messagesInput: ChatMessage[]): Promise<AssistantMessage> {
  const base = config.modelBaseUrl.endsWith("/")
    ? config.modelBaseUrl
    : `${config.modelBaseUrl}/`;
  const response = await fetch(new URL("chat/completions", base), {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.modelApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages: messagesInput,
      tools: relayFunctionTools,
      tool_choice: "auto",
    }),
  });
  const payload = (await response.json()) as {
    error?: { message?: string };
    choices?: Array<{ message?: AssistantMessage }>;
  };
  if (!response.ok) {
    throw new Error(
      payload.error?.message ??
        `Model API returned HTTP ${response.status}`,
    );
  }
  const message = payload.choices?.[0]?.message;
  if (message === undefined || message.role !== "assistant") {
    throw new Error("Model API returned no assistant message");
  }
  return message;
}

function required(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
