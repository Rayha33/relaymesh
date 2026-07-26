import {
  RelayAgentClient,
  RelayApiError,
} from "../src/sdk/client.js";

const baseUrl = process.env.RELAYMESH_URL ?? "http://127.0.0.1:4317";
const missionId = required("RELAYMESH_MISSION_ID");
const agentId = required("RELAYMESH_AGENT_ID");
const agentKey = required("RELAYMESH_AGENT_KEY");

const agent = new RelayAgentClient(agentId, agentKey, { baseUrl });
const { session } = await agent.join(missionId, {
  model: process.env.RELAYMESH_MODEL ?? "example-worker",
  role: process.env.RELAYMESH_ROLE ?? "worker",
  capabilities: (process.env.RELAYMESH_CAPABILITIES ?? "general").split(","),
  recoveryFromSessionId: null,
});

const heartbeat = setInterval(() => {
  void session.heartbeat().catch((error: unknown) => {
    process.stderr.write(
      `Heartbeat failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  });
}, 10_000);
heartbeat.unref();

try {
  const claim = await session.claim();
  if (claim === null) {
    process.stdout.write("No compatible work is queued.\n");
  } else {
    process.stdout.write(`Claimed: ${claim.task.title}\n`);
    if (claim.checkpoint !== null) {
      process.stdout.write(
        `Recovered checkpoint: ${claim.checkpoint.summary}\nNext: ${claim.checkpoint.nextAction}\n`,
      );
    }

    await session.checkpoint(claim.task.id, {
      leaseId: claim.lease.id,
      fencingToken: claim.lease.fencingToken,
      summary: "Example worker accepted the task and reconstructed its state.",
      nextAction: "Replace this example with real model work.",
      decisions: [],
      artifactIds: [],
      opaqueState: null,
    });

    await session.sendMessage({
      toSessionId: null,
      toRole: null,
      intent: "inform",
      subject: `Work started: ${claim.task.title}`,
      content: "A durable checkpoint is available if this session disappears.",
      priority: 0,
      correlationId: null,
      replyToId: null,
      artifactIds: [],
    });
  }
} catch (error) {
  if (error instanceof RelayApiError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
  } else {
    throw error;
  }
} finally {
  clearInterval(heartbeat);
  await session.leave();
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}
