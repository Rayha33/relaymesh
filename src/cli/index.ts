#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

if (command === "token") {
  if (token === null) {
    fail("No local admin token found");
  }
  process.stdout.write(`${token}\n`);
  process.exit(0);
}

if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
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
  npm run cli -- <command> [options]

Commands:
  token
  status
  agent:create  --name NAME --provider PROVIDER --model MODEL
  agent:list
  mission:create --title TITLE --objective OBJECTIVE
  mission:list
  mission:show --mission ID
  task:create --mission ID --title TITLE --description TEXT
              [--capabilities a,b] [--dependencies id,id]
              [--role ROLE] [--priority N] [--attempts N]
  recover
  verify --mission ID

Global options:
  --url URL
  --token TOKEN
`);
}
