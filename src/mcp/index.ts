#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RelayAgentClient } from "../sdk/client.js";
import { createRelayMcpServer } from "./server.js";

const config = {
  baseUrl: requiredEnv("RELAYMESH_URL", "http://127.0.0.1:4317"),
  missionId: requiredEnv("RELAYMESH_MISSION_ID"),
  agentId: requiredEnv("RELAYMESH_AGENT_ID"),
  agentKey: requiredEnv("RELAYMESH_AGENT_KEY"),
  model: requiredEnv("RELAYMESH_MODEL", "unknown"),
  role: requiredEnv("RELAYMESH_ROLE", "worker"),
  capabilities: requiredEnv("RELAYMESH_CAPABILITIES", "general")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
};

const agent = new RelayAgentClient(config.agentId, config.agentKey, {
  baseUrl: config.baseUrl,
});
const { joined, session } = await agent.join(config.missionId, {
  model: config.model,
  role: config.role,
  capabilities: config.capabilities,
  recoveryFromSessionId: process.env.RELAYMESH_RECOVERY_SESSION_ID ?? null,
});
const server = createRelayMcpServer(session, joined);

const heartbeatTimer = setInterval(() => {
  void session.heartbeat().catch((error: unknown) => {
    process.stderr.write(
      `RelayMesh heartbeat failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  });
}, 10_000);
heartbeatTimer.unref();

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  `RelayMesh MCP joined mission ${config.missionId} as session ${joined.session.id}\n`,
);

function requiredEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value.length === 0) {
    process.stderr.write(`Missing required environment variable ${name}\n`);
    process.exit(1);
  }
  return value;
}
