import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../server/config.js";
import { RelayRuntime } from "../core/runtime.js";

const config = loadConfig();
const runtime = new RelayRuntime({
  databasePath: config.databasePath,
  dataDirectory: config.dataDirectory,
  heartbeatTimeoutMs: config.heartbeatTimeoutMs,
  leaseDurationMs: config.leaseDurationMs,
  sessionTtlMs: config.sessionTtlMs,
  ...(config.adminToken === undefined ? {} : { adminToken: config.adminToken }),
});

function seed(): void {
  const existing = runtime.listMissions().find(
    (mission) => mission.title === "Ship a crash-safe multi-agent release",
  );
  if (existing !== undefined) {
    process.stdout.write(
      `Demo already exists: ${existing.id}\nAdmin token: relaymesh token (source: npm run cli -- token)\n`,
    );
    return;
  }

  const codex = runtime.createAgent({
    name: "Codex Builder",
    provider: "OpenAI",
    defaultModel: "gpt-5.6",
    description: "Implements and tests production code.",
  });
  const claude = runtime.createAgent({
    name: "Claude Architect",
    provider: "Anthropic",
    defaultModel: "claude-opus",
    description: "Challenges architecture and creates recovery checkpoints.",
  });
  const gemini = runtime.createAgent({
    name: "Gemini Verifier",
    provider: "Google",
    defaultModel: "gemini-pro",
    description: "Runs independent browser and evidence verification.",
  });
  const mission = runtime.createMission({
    title: "Ship a crash-safe multi-agent release",
    objective:
      "Coordinate three different AI model families to implement, challenge, and verify a release. Work must survive one deliberately lost session and complete from the latest checkpoint.",
  });
  const architecture = runtime.createTask(mission.id, {
    title: "Specify coordination invariants",
    description:
      "Define leases, fencing, checkpoints, message intents, and the observable completion conditions.",
    parentTaskId: null,
    priority: 10,
    requiredCapabilities: ["architecture.systems"],
    dependencies: [],
    assignedRole: "architect",
    maxAttempts: 3,
  });
  const implementation = runtime.createTask(mission.id, {
    title: "Implement the durable runtime",
    description:
      "Build the API and recovery loop against the accepted coordination invariants.",
    parentTaskId: null,
    priority: 8,
    requiredCapabilities: ["code.typescript"],
    dependencies: [architecture.id],
    assignedRole: "builder",
    maxAttempts: 3,
  });
  runtime.createTask(mission.id, {
    title: "Verify crash recovery in the browser",
    description:
      "Simulate a lost builder session, prove stale-fence rejection, resume from its checkpoint, and inspect the signed event chain.",
    parentTaskId: null,
    priority: 7,
    requiredCapabilities: ["test.browser"],
    dependencies: [implementation.id],
    assignedRole: "reviewer",
    maxAttempts: 3,
  });

  const credentialsPath = join(config.dataDirectory, "demo-credentials.json");
  writeFileSync(
    credentialsPath,
    JSON.stringify(
      {
        mission,
        agents: {
          codex: { ...codex.agent, agentKey: codex.agentKey },
          claude: { ...claude.agent, agentKey: claude.agentKey },
          gemini: { ...gemini.agent, agentKey: gemini.agentKey },
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  chmodSync(credentialsPath, 0o600);

  process.stdout.write(
    [
      "RelayMesh demo initialized.",
      `Mission: ${mission.id}`,
      `Credentials: ${credentialsPath}`,
      "Admin token: relaymesh token (source: npm run cli -- token)",
      "Start: relaymesh start (source: npm run dev)",
    ].join("\n") + "\n",
  );
}

try {
  seed();
} finally {
  runtime.close();
}
