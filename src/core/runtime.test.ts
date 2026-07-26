import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RelayError } from "./errors.js";
import { RelayRuntime } from "./runtime.js";
import type { SessionClaims } from "./crypto.js";

interface TestContext {
  runtime: RelayRuntime;
  advance: (milliseconds: number) => void;
  cleanup: () => void;
}

const contexts: TestContext[] = [];

afterEach(() => {
  for (const context of contexts.splice(0)) {
    context.cleanup();
  }
});

function createContext(): TestContext {
  const directory = mkdtempSync(join(tmpdir(), "relaymesh-runtime-"));
  let current = Date.parse("2026-07-26T12:00:00.000Z");
  const runtime = new RelayRuntime({
    databasePath: join(directory, "relaymesh.sqlite"),
    dataDirectory: directory,
    adminToken: "test-admin-token-that-is-long-enough",
    heartbeatTimeoutMs: 1_000,
    leaseDurationMs: 2_000,
    sessionTtlMs: 60_000,
    now: () => new Date(current),
  });
  const context = {
    runtime,
    advance(milliseconds: number) {
      current += milliseconds;
    },
    cleanup() {
      runtime.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  contexts.push(context);
  return context;
}

async function registerAndJoin(
  runtime: RelayRuntime,
  missionId: string,
  name: string,
  capabilities: string[],
  role = "worker",
): Promise<{
  claims: SessionClaims;
  sessionId: string;
  agentId: string;
}> {
  const registration = runtime.createAgent({
    name,
    provider: name.includes("Gemini") ? "Google" : "OpenAI",
    defaultModel: "frontier-model",
    description: "test agent",
  });
  const joined = await runtime.joinSession(
    missionId,
    registration.agent,
    {
      model: registration.agent.defaultModel,
      role,
      capabilities,
      recoveryFromSessionId: null,
    },
    `join-${name}`,
  );
  return {
    claims: await runtime.authenticateSession(joined.sessionToken),
    sessionId: joined.session.id,
    agentId: registration.agent.id,
  };
}

describe("RelayRuntime", () => {
  it("matches queued work by capabilities, role, and dependencies", async () => {
    const { runtime } = createContext();
    const mission = runtime.createMission({
      title: "Build and verify",
      objective: "Coordinate implementation and browser verification.",
    });
    const first = runtime.createTask(mission.id, {
      title: "Implement runtime",
      description: "Write the durable core.",
      parentTaskId: null,
      priority: 5,
      requiredCapabilities: ["code.typescript"],
      dependencies: [],
      assignedRole: "builder",
      maxAttempts: 3,
    });
    runtime.createTask(mission.id, {
      title: "Verify UI",
      description: "Run browser validation after implementation.",
      parentTaskId: null,
      priority: 10,
      requiredCapabilities: ["test.browser"],
      dependencies: [first.id],
      assignedRole: "reviewer",
      maxAttempts: 3,
    });

    const builder = await registerAndJoin(
      runtime,
      mission.id,
      "Codex Builder",
      ["code.typescript"],
      "builder",
    );
    const claim = runtime.claimTask(builder.claims, "claim-builder");
    expect(claim?.task.id).toBe(first.id);
    expect(claim?.lease.fencingToken).toBe(1);

    runtime.completeTask(
      builder.claims,
      first.id,
      {
        leaseId: claim!.lease.id,
        fencingToken: claim!.lease.fencingToken,
        result: { tests: "pending" },
      },
      "complete-first",
    );

    const reviewer = await registerAndJoin(
      runtime,
      mission.id,
      "Gemini Reviewer",
      ["test.browser"],
      "reviewer",
    );
    expect(runtime.claimTask(reviewer.claims)?.task.title).toBe("Verify UI");
  });

  it("recovers checkpointed work and rejects the crashed session's stale fence", async () => {
    const { runtime, advance } = createContext();
    const mission = runtime.createMission({
      title: "Crash-safe mission",
      objective: "Continue work after the first model process disappears.",
    });
    const task = runtime.createTask(mission.id, {
      title: "Implement protocol",
      description: "Create the session protocol.",
      parentTaskId: null,
      priority: 1,
      requiredCapabilities: ["code.typescript"],
      dependencies: [],
      assignedRole: null,
      maxAttempts: 3,
    });
    const first = await registerAndJoin(
      runtime,
      mission.id,
      "Codex One",
      ["code.typescript"],
    );
    const firstClaim = runtime.claimTask(first.claims)!;
    const checkpoint = runtime.checkpointTask(first.claims, task.id, {
      leaseId: firstClaim.lease.id,
      fencingToken: firstClaim.lease.fencingToken,
      summary: "Schema and event store implemented.",
      nextAction: "Finish recovery sweeper.",
      decisions: [{ decision: "Use leased ownership", rationale: "Crash safety" }],
      artifactIds: [],
      opaqueState: { branch: "agent/runtime" },
    });
    expect(checkpoint.summary).toContain("event store");

    advance(3_000);
    const report = runtime.recover();
    expect(report.lostSessions).toContain(first.sessionId);
    expect(report.requeuedTasks).toContain(task.id);

    const second = await registerAndJoin(
      runtime,
      mission.id,
      "Gemini Two",
      ["code.typescript"],
    );
    const secondClaim = runtime.claimTask(second.claims)!;
    expect(secondClaim.lease.fencingToken).toBe(2);
    expect(secondClaim.checkpoint?.nextAction).toBe("Finish recovery sweeper.");

    expect(() =>
      runtime.completeTask(first.claims, task.id, {
        leaseId: firstClaim.lease.id,
        fencingToken: firstClaim.lease.fencingToken,
        result: { stale: true },
      }),
    ).toThrow(RelayError);

    runtime.completeTask(second.claims, task.id, {
      leaseId: secondClaim.lease.id,
      fencingToken: secondClaim.lease.fencingToken,
      result: { recovered: true },
    });
    expect(runtime.getMission(mission.id).status).toBe("completed");
  });

  it("fails a mission once when recovery exhausts parallel leases", async () => {
    const { runtime, advance } = createContext();
    const mission = runtime.createMission({
      title: "Exhausted recovery",
      objective: "Fail deterministically when parallel work cannot recover.",
    });
    const tasks = ["First fragile task", "Second fragile task"].map((title) =>
      runtime.createTask(mission.id, {
        title,
        description: "Only one attempt is allowed.",
        parentTaskId: null,
        priority: 1,
        requiredCapabilities: ["general"],
        dependencies: [],
        assignedRole: null,
        maxAttempts: 1,
      }),
    );
    const first = await registerAndJoin(
      runtime,
      mission.id,
      "Fragile Worker One",
      ["general"],
    );
    const second = await registerAndJoin(
      runtime,
      mission.id,
      "Fragile Worker Two",
      ["general"],
    );
    expect(runtime.claimTask(first.claims)).not.toBeNull();
    expect(runtime.claimTask(second.claims)).not.toBeNull();

    advance(3_000);
    const report = runtime.recover();
    expect(report.lostSessions).toHaveLength(2);
    expect(report.failedTasks).toHaveLength(1);
    expect(report.expiredLeases).toHaveLength(1);
    expect(runtime.getMission(mission.id).status).toBe("failed");
    expect(tasks.map((task) => runtime.getTask(task.id).status).sort()).toEqual([
      "cancelled",
      "failed",
    ]);
  });

  it("delivers role messages at least once until acknowledged", async () => {
    const { runtime } = createContext();
    const mission = runtime.createMission({
      title: "Message mission",
      objective: "Coordinate a challenge and response.",
    });
    const coordinator = await registerAndJoin(
      runtime,
      mission.id,
      "Coordinator",
      ["general"],
      "coordinator",
    );
    const reviewer = await registerAndJoin(
      runtime,
      mission.id,
      "Reviewer",
      ["general"],
      "reviewer",
    );
    const message = runtime.sendMessage(coordinator.claims, {
      toSessionId: null,
      toRole: "reviewer",
      intent: "challenge",
      subject: "Verify the lease semantics",
      content: "Find a stale-write failure mode.",
      priority: 9,
      correlationId: null,
      replyToId: null,
      artifactIds: [],
    });
    expect(runtime.listInbox(reviewer.claims)).toHaveLength(1);
    runtime.acknowledgeMessage(reviewer.claims, message.id);
    expect(runtime.listInbox(reviewer.claims)).toHaveLength(0);
    expect(runtime.listInbox(reviewer.claims, true)[0]?.acknowledgedAt).not.toBeNull();
  });

  it("publishes content-addressed artifacts and enforces mission scope", async () => {
    const { runtime } = createContext();
    const mission = runtime.createMission({
      title: "Artifact mission",
      objective: "Exchange a durable output.",
    });
    const worker = await registerAndJoin(
      runtime,
      mission.id,
      "Worker",
      ["general"],
    );
    const content = Buffer.from("verified artifact");
    const artifact = runtime.createArtifact(worker.claims, {
      taskId: null,
      name: "result.txt",
      mimeType: "text/plain",
      contentBase64: content.toString("base64"),
      metadata: { verified: true },
    });
    expect(artifact.sha256).toHaveLength(64);
    expect(runtime.readArtifact(worker.claims, artifact.id).content).toEqual(
      content,
    );

    const otherMission = runtime.createMission({
      title: "Other",
      objective: "Remain isolated.",
    });
    const outsider = await registerAndJoin(
      runtime,
      otherMission.id,
      "Outsider",
      ["general"],
    );
    expect(() => runtime.readArtifact(outsider.claims, artifact.id)).toThrow(
      /another mission/i,
    );
  });

  it("keeps null idempotency results stable when new work later appears", async () => {
    const { runtime } = createContext();
    const mission = runtime.createMission({
      title: "Idempotency",
      objective: "Retries must not mutate twice.",
    });
    const worker = await registerAndJoin(
      runtime,
      mission.id,
      "Worker",
      ["general"],
    );
    expect(runtime.claimTask(worker.claims, "same-empty-claim")).toBeNull();
    runtime.createTask(mission.id, {
      title: "Appeared later",
      description: "Must not be claimed by a replayed request.",
      parentTaskId: null,
      priority: 0,
      requiredCapabilities: ["general"],
      dependencies: [],
      assignedRole: null,
      maxAttempts: 3,
    });
    expect(runtime.claimTask(worker.claims, "same-empty-claim")).toBeNull();
    expect(runtime.claimTask(worker.claims, "new-claim")).not.toBeNull();
  });

  it("detects tampering in the signed event chain", () => {
    const { runtime } = createContext();
    const mission = runtime.createMission({
      title: "Integrity",
      objective: "Detect modified history.",
    });
    runtime.createTask(mission.id, {
      title: "Original",
      description: "Original task.",
      parentTaskId: null,
      priority: 0,
      requiredCapabilities: [],
      dependencies: [],
      assignedRole: null,
      maxAttempts: 3,
    });
    expect(runtime.events.verify(mission.id).valid).toBe(true);
    runtime.database.raw
      .prepare(
        "UPDATE relay_events SET payload_json = ? WHERE mission_id = ? AND sequence = (SELECT MIN(sequence) FROM relay_events WHERE mission_id = ?)",
      )
      .run('{"tampered":true}', mission.id, mission.id);
    const verification = runtime.events.verify(mission.id);
    expect(verification.valid).toBe(false);
    expect(verification.reason).toMatch(/hash/i);
  });

  it("revokes agent credentials and every active session", async () => {
    const { runtime } = createContext();
    const registration = runtime.createAgent({
      name: "Revocable Worker",
      provider: "Independent",
      defaultModel: "local-model",
      description: "Credential lifecycle test",
    });
    const mission = runtime.createMission({
      title: "Credential lifecycle",
      objective: "Ensure revoked agents cannot continue operating.",
    });
    expect(
      runtime.authenticateAgent(registration.agent.id, registration.agentKey).id,
    ).toBe(registration.agent.id);
    expect(() =>
      runtime.authenticateAgent(registration.agent.id, "wrong-key"),
    ).toThrow(/invalid/i);

    const joined = await runtime.joinSession(
      mission.id,
      registration.agent,
      {
        model: "local-model",
        role: "worker",
        capabilities: ["general", "general"],
        recoveryFromSessionId: null,
      },
      "credential-join",
    );
    expect(joined.session.capabilities).toEqual(["general"]);
    await expect(
      runtime.authenticateSession(joined.sessionToken),
    ).resolves.toMatchObject({ sessionId: joined.session.id });

    expect(runtime.listAgents()).toHaveLength(1);
    expect(runtime.listSessions(mission.id)).toHaveLength(1);
    expect(runtime.revokeAgent(registration.agent.id).status).toBe("revoked");
    expect(() =>
      runtime.authenticateAgent(registration.agent.id, registration.agentKey),
    ).toThrow(/invalid/i);
    await expect(
      runtime.authenticateSession(joined.sessionToken),
    ).rejects.toMatchObject({ code: "SESSION_INACTIVE" });
  });

  it("renews leased work on heartbeat and safely requeues it when leaving", async () => {
    const { runtime, advance } = createContext();
    const mission = runtime.createMission({
      title: "Graceful handoff",
      objective: "Return unfinished work to the shared queue.",
    });
    const task = runtime.createTask(mission.id, {
      title: "Long-running work",
      description: "Checkpoint and hand off.",
      parentTaskId: null,
      priority: 1,
      requiredCapabilities: ["general"],
      dependencies: [],
      assignedRole: null,
      maxAttempts: 3,
    });
    const worker = await registerAndJoin(
      runtime,
      mission.id,
      "Heartbeat Worker",
      ["general"],
    );
    const claim = runtime.claimTask(worker.claims)!;
    advance(500);
    const heartbeat = runtime.heartbeat(worker.claims, "heartbeat-once");
    expect(heartbeat.renewedLeases).toEqual([
      expect.objectContaining({ leaseId: claim.lease.id }),
    ]);
    expect(runtime.heartbeat(worker.claims, "heartbeat-once")).toEqual(heartbeat);

    expect(runtime.leaveSession(worker.claims).status).toBe("left");
    expect(runtime.getTask(task.id).status).toBe("queued");
    expect(() => runtime.heartbeat(worker.claims)).toThrow(/no longer active/i);
    expect(runtime.getMissionSnapshot(mission.id).tasks).toHaveLength(1);
    expect(runtime.getMissionSnapshot(mission.id, worker.sessionId).sessions).toHaveLength(
      1,
    );
    const overview = runtime.getOverview();
    expect(overview.counts.queuedTasks).toBe(1);
    expect(overview.chain.valid).toBe(true);
    expect(overview.chain.checked).toBe(overview.recentEvents.length);
    expect(
      overview.recentEvents.some((event) => event.type === "session.left"),
    ).toBe(true);
  });

  it("retries failures up to the attempt limit and then fences them closed", async () => {
    const { runtime } = createContext();
    const mission = runtime.createMission({
      title: "Bounded retries",
      objective: "Prevent permanently failing work from looping forever.",
    });
    const task = runtime.createTask(mission.id, {
      title: "Unstable operation",
      description: "Fail twice.",
      parentTaskId: null,
      priority: 1,
      requiredCapabilities: ["general"],
      dependencies: [],
      assignedRole: null,
      maxAttempts: 2,
    });
    const dependent = runtime.createTask(mission.id, {
      title: "Dependent operation",
      description: "Cannot run after its dependency is exhausted.",
      parentTaskId: null,
      priority: 0,
      requiredCapabilities: ["general"],
      dependencies: [task.id],
      assignedRole: null,
      maxAttempts: 2,
    });
    const worker = await registerAndJoin(
      runtime,
      mission.id,
      "Retry Worker",
      ["general"],
    );
    const first = runtime.claimTask(worker.claims)!;
    expect(
      runtime.failTask(worker.claims, task.id, {
        leaseId: first.lease.id,
        fencingToken: first.lease.fencingToken,
        reason: "Transient provider failure",
        retryable: true,
      }).status,
    ).toBe("queued");

    const second = runtime.claimTask(worker.claims)!;
    expect(second.task.attempt).toBe(2);
    expect(
      runtime.failTask(
        worker.claims,
        task.id,
        {
          leaseId: second.lease.id,
          fencingToken: second.lease.fencingToken,
          reason: "Repeated provider failure",
          retryable: true,
        },
        "terminal-failure",
      ).status,
    ).toBe("failed");
    expect(runtime.getMission(mission.id).status).toBe("failed");
    expect(runtime.getTask(dependent.id).status).toBe("cancelled");
    expect(
      runtime.failTask(
        worker.claims,
        task.id,
        {
          leaseId: second.lease.id,
          fencingToken: second.lease.fencingToken,
          reason: "Repeated provider failure",
          retryable: true,
        },
        "terminal-failure",
      ).status,
    ).toBe("failed");
  });

  it("rejects cross-mission task references and idempotency key reuse", async () => {
    const { runtime } = createContext();
    const firstMission = runtime.createMission({
      title: "First scope",
      objective: "Own its work.",
    });
    const secondMission = runtime.createMission({
      title: "Second scope",
      objective: "Remain isolated.",
    });
    const foreignTask = runtime.createTask(firstMission.id, {
      title: "Foreign task",
      description: "Cannot be referenced elsewhere.",
      parentTaskId: null,
      priority: 0,
      requiredCapabilities: [],
      dependencies: [],
      assignedRole: null,
      maxAttempts: 1,
    });
    expect(() =>
      runtime.createTask(secondMission.id, {
        title: "Invalid dependency",
        description: "Crosses the mission boundary.",
        parentTaskId: null,
        priority: 0,
        requiredCapabilities: [],
        dependencies: [foreignTask.id],
        assignedRole: null,
        maxAttempts: 1,
      }),
    ).toThrow(/mission boundaries/i);

    const worker = await registerAndJoin(
      runtime,
      secondMission.id,
      "Scoped Worker",
      ["general"],
    );
    expect(runtime.claimTask(worker.claims, "shared-key")).toBeNull();
    expect(() =>
      runtime.sendMessage(
        worker.claims,
        {
          toSessionId: null,
          toRole: null,
          intent: "inform",
          subject: "Collision",
          content: "This operation must not reuse a claim key.",
          priority: 0,
          correlationId: null,
          replyToId: null,
          artifactIds: [],
        },
        "shared-key",
      ),
    ).toThrow(/another operation/i);

    runtime.updateMissionStatus(secondMission.id, "cancelled");
    expect(() =>
      runtime.createTask(secondMission.id, {
        title: "Too late",
        description: "Terminal missions reject new work.",
        parentTaskId: null,
        priority: 0,
        requiredCapabilities: [],
        dependencies: [],
        assignedRole: null,
        maxAttempts: 1,
      }),
    ).toThrow(/terminal mission/i);
    expect(() =>
      runtime.updateMissionStatus(secondMission.id, "active"),
    ).toThrow(/cannot transition/i);
  });

  it("fences active work when an operator cancels its mission", async () => {
    const { runtime } = createContext();
    const mission = runtime.createMission({
      title: "Cancelled operation",
      objective: "Stop all in-flight work safely.",
    });
    const task = runtime.createTask(mission.id, {
      title: "In-flight task",
      description: "Must be fenced on cancellation.",
      parentTaskId: null,
      priority: 1,
      requiredCapabilities: ["general"],
      dependencies: [],
      assignedRole: null,
      maxAttempts: 3,
    });
    const worker = await registerAndJoin(
      runtime,
      mission.id,
      "Cancellation Worker",
      ["general"],
    );
    const claim = runtime.claimTask(worker.claims)!;

    expect(runtime.updateMissionStatus(mission.id, "cancelled").status).toBe(
      "cancelled",
    );
    expect(runtime.getTask(task.id).status).toBe("cancelled");
    expect(() =>
      runtime.completeTask(worker.claims, task.id, {
        leaseId: claim.lease.id,
        fencingToken: claim.lease.fencingToken,
        result: { late: true },
      }),
    ).toThrow(/stale/i);
  });

  it("does not auto-complete paused missions until they resume", async () => {
    const { runtime } = createContext();
    const mission = runtime.createMission({
      title: "Paused completion",
      objective: "Keep operator control over the terminal transition.",
    });
    const task = runtime.createTask(mission.id, {
      title: "Finish while paused",
      description: "Complete the task without changing mission state.",
      parentTaskId: null,
      priority: 1,
      requiredCapabilities: ["general"],
      dependencies: [],
      assignedRole: null,
      maxAttempts: 3,
    });
    const worker = await registerAndJoin(
      runtime,
      mission.id,
      "Paused Worker",
      ["general"],
    );
    const claim = runtime.claimTask(worker.claims)!;
    runtime.updateMissionStatus(mission.id, "paused");
    runtime.completeTask(worker.claims, task.id, {
      leaseId: claim.lease.id,
      fencingToken: claim.lease.fencingToken,
      result: { done: true },
    });

    expect(runtime.getMission(mission.id).status).toBe("paused");
    expect(runtime.updateMissionStatus(mission.id, "active").status).toBe(
      "completed",
    );
  });

  it("rejects empty artifacts and messages not addressed to the recipient", async () => {
    const { runtime } = createContext();
    const mission = runtime.createMission({
      title: "Input boundaries",
      objective: "Reject invalid durable exchanges.",
    });
    const sender = await registerAndJoin(
      runtime,
      mission.id,
      "Boundary Sender",
      ["general"],
      "sender",
    );
    const recipient = await registerAndJoin(
      runtime,
      mission.id,
      "Boundary Recipient",
      ["general"],
      "recipient",
    );
    expect(() =>
      runtime.createArtifact(sender.claims, {
        taskId: null,
        name: "empty.txt",
        mimeType: "text/plain",
        contentBase64: "",
        metadata: {},
      }),
    ).toThrow(/between 1 byte/i);

    const message = runtime.sendMessage(sender.claims, {
      toSessionId: recipient.sessionId,
      toRole: null,
      intent: "request",
      subject: "Recipient-only",
      content: "Only the intended session may acknowledge this.",
      priority: 1,
      correlationId: null,
      replyToId: null,
      artifactIds: [],
    });
    expect(runtime.getMessage(message.id).id).toBe(message.id);
    expect(runtime.listMessages(mission.id)).toHaveLength(1);
    expect(() => runtime.acknowledgeMessage(sender.claims, message.id)).toThrow(
      /not addressed/i,
    );
  });
});
