#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  planProductivityWorkflow,
  type WorkflowMode,
} from "../core/workflow.js";
import { RelayAdminClient } from "../sdk/client.js";

const args = process.argv.slice(2);
const command = args.shift() ?? "help";
const baseUrl = option("--url") ?? process.env.RELAYMESH_URL ?? "http://127.0.0.1:4317";
const dataDirectory = resolve(
  process.cwd(),
  process.env.RELAYMESH_DATA_DIR ?? "./data",
);
const token =
  option("--token") ??
  process.env.RELAYMESH_ADMIN_TOKEN ??
  readToken(resolve(dataDirectory, "admin-token.txt"));

if (command === "start") {
  await import("../server/index.js");
} else if (command === "demo") {
  await import("../scripts/seed-demo.js");
  await import("../server/index.js");
} else if (command === "demo:seed") {
  await import("../scripts/seed-demo.js");
} else if (command === "worker:openai") {
  await import("../../examples/openai-compatible-worker.js");
} else {
  await runAdminCommand();
}

async function runAdminCommand(): Promise<void> {
  if (command === "token") {
    if (token === null) {
      fail("No local admin token found");
    }
    process.stdout.write(`${token}\n`);
    return;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "connect") {
    printConnectionGuide();
    return;
  }

  if (token === null) {
    fail(
      "Admin token not found. Set RELAYMESH_ADMIN_TOKEN or start the server once.",
    );
  }
  const admin = new RelayAdminClient(token, { baseUrl });

  try {
    switch (command) {
      case "status": {
        print(await admin.overview());
        break;
      }
      case "agent:create": {
        const name = required("--name");
        const provider = required("--provider");
        const defaultModel = required("--model");
        print(
          await admin.createAgent({
            name,
            provider,
            defaultModel,
            description: option("--description") ?? "",
          }),
        );
        break;
      }
      case "agent:list": {
        print(await admin.listAgents());
        break;
      }
      case "connect:create": {
        const created = await admin.createConnectionTicket(
          required("--mission"),
          {
            agentId: required("--agent"),
            model: required("--model"),
            role: option("--role") ?? "worker",
            capabilities: defaultCapabilities(
              csv(option("--capabilities")),
            ),
            expiresInHours: Number.parseInt(
              option("--ttl-hours") ?? "24",
              10,
            ),
          },
        );
        print({
          connection: created.connection,
          mcpUrl: new URL(
            `/mcp/connect/${encodeURIComponent(created.ticket)}`,
            baseUrl,
          ).href,
          a2a: a2aConnection(created.ticket),
          warning:
            "This URL is a scoped credential. Do not commit, share, or log it.",
        });
        break;
      }
      case "connect:list": {
        print(await admin.listConnectionTickets());
        break;
      }
      case "connect:revoke": {
        print(
          await admin.revokeConnectionTicket(
            required("--connection"),
          ),
        );
        break;
      }
      case "launch": {
        const objective = required("--objective");
        const title = option("--title") ?? "RelayMesh mission";
        const models = defaultCapabilities(
          csv(option("--models") ?? "claude,chatgpt,deepseek"),
        );
        const role = option("--role") ?? "worker";
        const capabilities = defaultCapabilities(
          csv(option("--capabilities")),
        );
        const workflow = parseWorkflow(
          option("--workflow") ?? (models.length > 1 ? "parallel" : "single"),
        );
        const ttlHours = Number.parseInt(
          option("--ttl-hours") ?? "24",
          10,
        );
        const mission = await admin.createMission({ title, objective });
        const taskPlans = planProductivityWorkflow({
          objective,
          contributorCount: models.length,
          mode: workflow,
        });
        const tasksByKey = new Map<string, Awaited<ReturnType<typeof admin.createTask>>>();
        for (const plan of taskPlans) {
          const dependencies = plan.dependencyKeys.map((key) => {
            const dependency = tasksByKey.get(key);
            if (dependency === undefined) {
              throw new Error(`Workflow dependency ${key} was not created`);
            }
            return dependency.id;
          });
          const task = await admin.createTask(mission.id, {
            title: plan.title,
            description: plan.description,
            parentTaskId: null,
            priority: plan.priority,
            requiredCapabilities: capabilities,
            dependencies,
            assignedRole: null,
            maxAttempts: 10,
          });
          tasksByKey.set(plan.key, task);
        }
        const tasks = [...tasksByKey.values()];
        const finalTask = tasksByKey.get("final")!;
        const connections = [];
        for (const model of models) {
          const registration = await admin.createAgent({
            name: `${model} ${role}`,
            provider: providerFor(model),
            defaultModel: model,
            description: `Zero-config ${model} connection for ${title}`,
          });
          const issued = await admin.createConnectionTicket(
            mission.id,
            {
              agentId: registration.agent.id,
              model,
              role,
              capabilities,
              expiresInHours: ttlHours,
            },
          );
          const scopedUrl = new URL(
            `/mcp/connect/${encodeURIComponent(issued.ticket)}`,
            baseUrl,
          ).href;
          const bearerUrl = new URL(
            `/mcp/${mission.id}/${registration.agent.id}`,
            baseUrl,
          );
          bearerUrl.searchParams.set("model", model);
          bearerUrl.searchParams.set("role", role);
          bearerUrl.searchParams.set(
            "capabilities",
            capabilities.join(","),
          );
          connections.push({
            model,
            provider: registration.agent.provider,
            agentId: registration.agent.id,
            agentKey: registration.agentKey,
            startupPrompt:
              "Call relay_sync. Work only on the returned lease, use attached dependencyOutputs, checkpoint durable progress, complete with a self-contained result, then call relay_sync again until the mission is terminal.",
            scopedMcpUrl: scopedUrl,
            a2a: a2aConnection(issued.ticket),
            bearerMcpUrl: bearerUrl.href,
            stdioMcp: {
              command: "relaymesh-mcp",
              env: {
                RELAYMESH_URL: baseUrl,
                RELAYMESH_MISSION_ID: mission.id,
                RELAYMESH_AGENT_ID: registration.agent.id,
                RELAYMESH_AGENT_KEY: registration.agentKey,
                RELAYMESH_MODEL: model,
                RELAYMESH_ROLE: role,
                RELAYMESH_CAPABILITIES: capabilities.join(","),
              },
            },
          });
        }
        print({
          protocol: "relaymesh/2",
          mission,
          task: finalTask,
          tasks,
          workflow: {
            mode: workflow,
            parallelContributions:
              workflow === "parallel" ? Math.min(models.length, tasks.length - 1) : 1,
            finalTaskId: finalTask.id,
          },
          connections,
          resultCommand: `relaymesh mission:result --mission ${mission.id} --url ${baseUrl}`,
          next:
            "Give each client its matching connection and startupPrompt. Models work in parallel; the final task automatically receives every dependency output.",
          warning:
            "This output contains one-time agent keys and scoped URLs. Store it privately.",
        });
        break;
      }
      case "mission:create": {
        print(
          await admin.createMission({
            title: required("--title"),
            objective: required("--objective"),
          }),
        );
        break;
      }
      case "mission:list": {
        print(await admin.listMissions());
        break;
      }
      case "mission:show": {
        print(await admin.getMission(required("--mission")));
        break;
      }
      case "mission:result": {
        print(await admin.getMissionResult(required("--mission")));
        break;
      }
      case "task:create": {
        print(
          await admin.createTask(required("--mission"), {
            title: required("--title"),
            description: required("--description"),
            parentTaskId: null,
            priority: Number.parseInt(option("--priority") ?? "0", 10),
            requiredCapabilities: csv(option("--capabilities")),
            dependencies: csv(option("--dependencies")),
            assignedRole: option("--role"),
            maxAttempts: Number.parseInt(option("--attempts") ?? "3", 10),
          }),
        );
        break;
      }
      case "recover": {
        print(await admin.recover());
        break;
      }
      case "verify": {
        print(await admin.verifyEvents(required("--mission")));
        break;
      }
      default:
        fail(`Unknown command: ${command}`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function printConnectionGuide(): void {
  const missionId = required("--mission");
  const agentId = required("--agent");
  const model = option("--model") ?? "any-model";
  const role = option("--role") ?? "worker";
  const capabilities = csv(option("--capabilities"));
  const effectiveCapabilities =
    capabilities.length > 0 ? capabilities : ["general"];
  const remoteUrl = new URL(`/mcp/${missionId}/${agentId}`, baseUrl);
  remoteUrl.searchParams.set("model", model);
  remoteUrl.searchParams.set("role", role);
  remoteUrl.searchParams.set(
    "capabilities",
    effectiveCapabilities.join(","),
  );

  print({
    protocol: "relaymesh/2",
    note: "Replace <agent-key> with the key returned by agent:create. Treat it as a secret.",
    stdioMcp: {
      useWith: ["Claude Desktop", "Claude Code", "Codex", "local MCP clients"],
      command: "relaymesh-mcp",
      env: {
        RELAYMESH_URL: baseUrl,
        RELAYMESH_MISSION_ID: missionId,
        RELAYMESH_AGENT_ID: agentId,
        RELAYMESH_AGENT_KEY: "<agent-key>",
        RELAYMESH_MODEL: model,
        RELAYMESH_ROLE: role,
        RELAYMESH_CAPABILITIES: effectiveCapabilities.join(","),
      },
    },
    remoteMcp: {
      useWith: [
        "OpenAI Responses API",
        "remote MCP clients",
        "HTTPS-forwarded private deployments",
      ],
      url: remoteUrl.href,
      authorization: "Bearer <agent-key>",
      transport: "streamable-http",
    },
    openAiCompatibleFunctions: {
      useWith: [
        "DeepSeek",
        "OpenAI-compatible APIs",
        "local function-calling models",
      ],
      manifestUrl: new URL(
        "/.well-known/relaymesh-tools.json",
        baseUrl,
      ).href,
      sdkExports: [
        "relayFunctionTools",
        "executeRelayFunction",
      ],
      runnableCommand: "relaymesh worker:openai",
    },
    a2a: {
      useWith: ["A2A v1.0 HTTP+JSON clients"],
      note:
        "Run connect:create to issue the required scoped ticket and print the authenticated A2A connection.",
      agentCardUrl: new URL(
        "/.well-known/agent-card.json",
        baseUrl,
      ).href,
    },
  });
}

function a2aConnection(ticket: string) {
  return {
    agentCardUrl: new URL(
      "/.well-known/agent-card.json",
      baseUrl,
    ).href,
    interfaceUrl: new URL("/a2a/v1", baseUrl).href,
    protocolBinding: "HTTP+JSON",
    headers: {
      "A2A-Extensions":
        "https://github.com/Rayha33/relaymesh/blob/main/docs/PROTOCOL.md#relaymesh-a2a-extension-v1",
      "A2A-Version": "1.0",
      Authorization: `Bearer ${ticket}`,
    },
  };
}

function option(name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }
  return args[index + 1] ?? null;
}

function required(name: string): string {
  const value = option(name);
  if (value === null || value.length === 0) {
    fail(`Missing required option ${name}`);
  }
  return value;
}

function csv(value: string | null): string[] {
  return value === null || value.length === 0
    ? []
    : value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function defaultCapabilities(values: string[]): string[] {
  return values.length > 0 ? values : ["general"];
}

function parseWorkflow(value: string): WorkflowMode {
  if (value === "parallel" || value === "single") return value;
  fail("--workflow must be parallel or single");
}

function providerFor(model: string): string {
  const normalized = model.toLowerCase();
  if (normalized.includes("claude")) return "Anthropic";
  if (
    normalized.includes("chatgpt") ||
    normalized.includes("gpt") ||
    normalized.includes("openai")
  ) {
    return "OpenAI";
  }
  if (normalized.includes("deepseek")) return "DeepSeek";
  if (normalized.includes("gemini")) return "Google";
  return "OpenAI-compatible";
}

function readToken(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string): never {
  process.stderr.write(`relaymesh: ${message}\n`);
  process.exit(1);
}

function printHelp(): void {
  process.stdout.write(`
RelayMesh CLI

Usage:
  relaymesh <command> [options]

From a source checkout:
  npm run cli -- <command> [options]

Commands:
  start
  demo
  demo:seed
  worker:openai
  launch --objective TEXT [--title TEXT]
         [--models claude,chatgpt,deepseek] [--role ROLE]
         [--workflow parallel|single]
         [--capabilities a,b] [--ttl-hours N]
  token
  connect --mission ID --agent ID [--model MODEL] [--role ROLE]
          [--capabilities a,b]
  connect:create --mission ID --agent ID --model MODEL
                 [--role ROLE] [--capabilities a,b] [--ttl-hours N]
  connect:list
  connect:revoke --connection ID
  status
  agent:create  --name NAME --provider PROVIDER --model MODEL
  agent:list
  mission:create --title TITLE --objective OBJECTIVE
  mission:list
  mission:show --mission ID
  mission:result --mission ID
  task:create --mission ID --title TITLE --description TEXT
              [--capabilities a,b] [--dependencies id,id]
              [--role ROLE] [--priority N] [--attempts N]
  recover
  verify --mission ID

Global options:
  --url URL
  --token TOKEN

OpenAI-compatible worker environment:
  MODEL_API_BASE, MODEL_API_KEY, MODEL_NAME
  RELAYMESH_MISSION_ID, RELAYMESH_AGENT_ID, RELAYMESH_AGENT_KEY
`);
}
