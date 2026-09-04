import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type RelayApp } from "../server/app.js";

interface Fixture {
  relay: RelayApp;
  directory: string;
  baseUrl: string;
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.relay.app.close();
    fixture.relay.runtime.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe("RelayMesh Streamable HTTP MCP", () => {
  it("recovers checkpointed work through a second model session", async () => {
    const fixture = await setup();
    const { runtime } = fixture.relay;
    const registration = runtime.createAgent({
      name: "Universal model",
      provider: "provider-neutral",
      defaultModel: "any-model",
      description: "Remote MCP integration test",
    });
    const mission = runtime.createMission({
      title: "Cross-model recovery",
      objective: "Continue work after the first model session disappears.",
    });
    const task = runtime.createTask(mission.id, {
      title: "Preserve progress",
      description: "Checkpoint, crash, recover, and complete.",
      parentTaskId: null,
      priority: 10,
      requiredCapabilities: ["general"],
      dependencies: [],
      assignedRole: null,
      maxAttempts: 3,
    });

    const first = await connect(
      fixture.baseUrl,
      mission.id,
      registration.agent.id,
      registration.agentKey,
      "claude-session",
    );
    const tools = await first.client.listTools();
    expect(tools.tools).toHaveLength(11);
    expect(
      tools.tools.every(
        (tool) =>
          tool.outputSchema !== undefined &&
          tool.annotations?.openWorldHint === false,
      ),
    ).toBe(true);

    const status = await first.client.callTool({ name: "relay_status" });
    expect(data(status)).toMatchObject({
      mission: { id: mission.id },
      session: { model: "claude-session" },
    });

    const claimResult = await first.client.callTool({
      name: "relay_claim_task",
    });
    const claim = data(claimResult) as {
      task: { id: string };
      lease: { id: string; fencingToken: number };
    };
    expect(claim.task.id).toBe(task.id);

    await first.client.callTool({
      name: "relay_checkpoint",
      arguments: {
        taskId: task.id,
        leaseId: claim.lease.id,
        fencingToken: claim.lease.fencingToken,
        summary: "Provider-neutral checkpoint",
        nextAction: "Continue in another model",
        decisionsJson: JSON.stringify([
          { decision: "Keep durable state outside model context" },
        ]),
        artifactIds: [],
        opaqueStateJson: "{}",
      },
    });
    const firstRelaySessionId = activeSessionId(runtime, mission.id);
    await first.transport.terminateSession();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(runtime.getSession(firstRelaySessionId).status).toBe("left");
    expect(runtime.getTask(task.id).status).toBe("queued");

    const second = await connect(
      fixture.baseUrl,
      mission.id,
      registration.agent.id,
      registration.agentKey,
      "deepseek-session",
    );
    const recoveredResult = await second.client.callTool({
      name: "relay_sync",
      arguments: {
        autoClaim: true,
        includeAcknowledged: false,
      },
    });
    const recovered = data(recoveredResult) as {
      protocol: string;
      work: {
        task: { id: string };
        lease: { id: string; fencingToken: number };
        checkpoint: { summary: string; nextAction: string };
      };
    };
    expect(recovered.protocol).toBe("relaymesh/2");
    expect(recovered.work.task.id).toBe(task.id);
    expect(recovered.work.checkpoint).toMatchObject({
      summary: "Provider-neutral checkpoint",
      nextAction: "Continue in another model",
    });

    await second.client.callTool({
      name: "relay_complete_task",
      arguments: {
        taskId: task.id,
        leaseId: recovered.work.lease.id,
        fencingToken: recovered.work.lease.fencingToken,
        resultJson: JSON.stringify({ recoveredBy: "deepseek-session" }),
      },
    });
    expect(runtime.getTask(task.id)).toMatchObject({
      status: "completed",
      result: { recoveredBy: "deepseek-session" },
    });
    await second.transport.terminateSession();
  });

  it("requires the correct agent key on every MCP connection", async () => {
    const fixture = await setup();
    const registration = fixture.relay.runtime.createAgent({
      name: "Protected agent",
      provider: "test",
      defaultModel: "test",
      description: "",
    });
    const mission = fixture.relay.runtime.createMission({
      title: "Protected mission",
      objective: "Reject invalid credentials.",
    });
    const response = await fetch(
      `${fixture.baseUrl}/mcp/${mission.id}/${registration.agent.id}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer wrong-agent-key",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "invalid-client", version: "1.0.0" },
          },
        }),
      },
    );
    expect(response.status).toBe(401);

    const connected = await connect(
      fixture.baseUrl,
      mission.id,
      registration.agent.id,
      registration.agentKey,
      "revoked-model",
    );
    fixture.relay.runtime.revokeAgent(registration.agent.id);
    await expect(connected.client.listTools()).rejects.toThrow();
  });

  it("connects closed ChatGPT-style clients with a scoped revocable URL", async () => {
    const fixture = await setup();
    const registration = fixture.relay.runtime.createAgent({
      name: "ChatGPT personal connection",
      provider: "OpenAI",
      defaultModel: "chatgpt",
      description: "",
    });
    const mission = fixture.relay.runtime.createMission({
      title: "Capability connection",
      objective: "Connect without custom client headers.",
    });
    const issued = fixture.relay.runtime.createConnectionTicket(
      mission.id,
      {
        agentId: registration.agent.id,
        model: "chatgpt",
        role: "reviewer",
        capabilities: ["general"],
        expiresInHours: 1,
      },
    );
    const connected = await connectTicket(
      fixture.baseUrl,
      issued.ticket,
    );
    const tools = await connected.client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "relay_claim_task",
    );

    fixture.relay.runtime.revokeConnectionTicket(
      issued.connection.id,
    );
    await expect(connected.client.listTools()).rejects.toThrow();
    expect(
      () =>
        fixture.relay.runtime.authenticateConnectionTicket(
          issued.ticket,
        ),
    ).toThrow("invalid, expired, or revoked");
  });

  // REGRESSION GATE for the fastify 5.12.1 graceful-shutdown hang (2026-09-03).
  // Once the MCP SDK client has a standalone GET SSE stream attached, that
  // stream never goes idle, so fastify's default ("idle") close() strategy
  // waits on its socket forever. src/server/index.ts awaits app.close() inside
  // its SIGTERM handler with no timeout, which means a production RelayMesh
  // with any agent attached can only be SIGKILLed.
  //
  // The client is deliberately NOT closed here: closing it masks the defect.
  //
  // The gate is only meaningful if the GET SSE stream is REALLY attached when
  // close() is raced. The SDK fires _startOrAuthSse() without awaiting it once
  // the initialized notification is accepted, so neither connect() nor a
  // successful listTools() POST establishes that -- an earlier version of this
  // gate assumed it did and passed the broken build 2 runs out of 5. It now
  // waits on server-side evidence that the stream is open before racing.
  it("closes the server while a streaming client is still attached", async () => {
    const fixture = await setup();
    const { runtime } = fixture.relay;
    const registration = runtime.createAgent({
      name: "Attached agent",
      provider: "test",
      defaultModel: "test",
      description: "",
    });
    const mission = runtime.createMission({
      title: "Shutdown while attached",
      objective: "Close the server without waiting on a live stream.",
    });
    // Watch before connecting: the standalone GET is an un-awaited side effect
    // of the initialized notification and can land at any moment after it.
    const attaching = attachedSseStream(fixture.relay.app.server);
    const connected = await connect(
      fixture.baseUrl,
      mission.id,
      registration.agent.id,
      registration.agentKey,
      "attached-model",
    );
    expect((await connected.client.listTools()).tools.length).toBeGreaterThan(0);

    // POSITIVE EVIDENCE that the object under test exists: RelayMesh is holding
    // an open, un-ended SSE response for the SDK's standalone GET stream RIGHT
    // NOW. Without this await, close() can win a race against a stream that
    // never attached and the gate goes green on a broken server.
    const stream = await attaching;
    const attachedBeforeClose = stream.headersSent && !stream.writableEnded;

    // Take ownership of the fixture so the shared afterEach does not also try
    // to close it, and so a regression fails HERE with a clear assertion rather
    // than as an opaque afterEach hook timeout.
    fixtures.splice(fixtures.indexOf(fixture), 1);
    let timer: NodeJS.Timeout | undefined;
    const closed = await Promise.race([
      fixture.relay.app.close().then(() => "closed" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), 5_000);
      }),
    ]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    fixture.relay.runtime.close();
    rmSync(fixture.directory, { recursive: true, force: true });
    expect(attachedBeforeClose).toBe(true);
    expect(closed).toBe("closed");
  }, 30_000);

});

async function setup(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), "relaymesh-mcp-http-"));
  const relay = await buildApp({
    host: "127.0.0.1",
    port: 4317,
    dataDirectory: directory,
    databasePath: join(directory, "relaymesh.sqlite"),
    adminToken: "integration-admin-token",
    heartbeatTimeoutMs: 50,
    leaseSweepMs: 1_000,
    leaseDurationMs: 5_000,
    sessionTtlMs: 60_000,
    roleReservationMs: 900_000,
  });
  await relay.app.listen({ host: "127.0.0.1", port: 0 });
  const address = relay.app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("RelayMesh did not expose a TCP test address");
  }
  const fixture = {
    relay,
    directory,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
  fixtures.push(fixture);
  return fixture;
}

async function connect(
  baseUrl: string,
  missionId: string,
  agentId: string,
  agentKey: string,
  model: string,
  recoveryFromSessionId?: string,
) {
  const url = new URL(`/mcp/${missionId}/${agentId}`, baseUrl);
  url.searchParams.set("model", model);
  url.searchParams.set("role", "builder");
  url.searchParams.set("capabilities", "general");
  if (recoveryFromSessionId !== undefined) {
    url.searchParams.set("recoveryFromSessionId", recoveryFromSessionId);
  }
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: { authorization: `Bearer ${agentKey}` },
    },
  });
  const client = new Client({
    name: `relaymesh-test-${model}`,
    version: "1.0.0",
  });
  await client.connect(
    transport as Parameters<typeof client.connect>[0],
  );
  return { client, transport };
}

async function connectTicket(baseUrl: string, ticket: string) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`/mcp/connect/${encodeURIComponent(ticket)}`, baseUrl),
  );
  const client = new Client({
    name: "relaymesh-ticket-test",
    version: "1.0.0",
  });
  await client.connect(
    transport as Parameters<typeof client.connect>[0],
  );
  return { client, transport };
}

function data(result: unknown): unknown {
  if (
    typeof result !== "object" ||
    result === null ||
    !("structuredContent" in result)
  ) {
    throw new Error("MCP result did not contain structured content");
  }
  const structured = result.structuredContent;
  if (
    typeof structured !== "object" ||
    structured === null ||
    !("data" in structured)
  ) {
    throw new Error("MCP structured content did not contain data");
  }
  return structured.data;
}

function activeSessionId(
  runtime: RelayApp["runtime"],
  missionId: string,
): string {
  const session = runtime
    .listSessions(missionId)
    .find((candidate) => candidate.status === "active");
  if (session === undefined) {
    throw new Error("No active RelayMesh session found");
  }
  return session.id;
}

/**
 * Resolves only when RelayMesh is actually holding the MCP SDK's standalone GET
 * SSE stream open: the GET has reached the HTTP server, the server has written
 * its response head, and the response has not ended. That is exactly the socket
 * state fastify's default ("idle") close() strategy waits on indefinitely, and
 * it is the precondition the shutdown gate needs before it races app.close().
 *
 * It is NOT implied by a successful request: the SDK calls _startOrAuthSse()
 * without awaiting it (node_modules/@modelcontextprotocol/sdk client
 * streamableHttp.js, in the 202-Accepted branch for the initialized
 * notification), so the GET races whatever the caller does next.
 */
async function attachedSseStream(
  server: Server,
  timeoutMs = 15_000,
): Promise<ServerResponse> {
  const seen: ServerResponse[] = [];
  const onRequest = (
    request: IncomingMessage,
    response: ServerResponse,
  ): void => {
    if (
      request.method === "GET" &&
      request.url?.startsWith("/mcp/") === true &&
      (request.headers.accept ?? "").includes("text/event-stream")
    ) {
      seen.push(response);
    }
  };
  server.on("request", onRequest);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const open = seen.find(
        (response) => response.headersSent && !response.writableEnded,
      );
      if (open !== undefined) {
        return open;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    server.off("request", onRequest);
  }
  throw new Error(
    `No MCP standalone GET SSE stream attached within ${timeoutMs}ms ` +
      `(${seen.length} matching GET request(s) reached the server). The ` +
      "shutdown gate proves nothing without one.",
  );
}
