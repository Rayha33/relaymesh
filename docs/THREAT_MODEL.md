# Threat model

RelayMesh coordinates untrusted or partially trusted AI agents. Model output is
data, never authority.

## Protected assets

- mission context and artifacts;
- agent and administrator credentials;
- task ownership and fencing tokens;
- event-log integrity;
- operator decisions;
- cross-agent messages.

## Trust boundaries

- Agent processes may be compromised, hallucinate, or ignore instructions.
- Model providers may observe prompts sent to their services.
- The local host and RelayMesh administrator are trusted in v1.
- Other agents in a mission are not implicitly trusted.

## Controls

- localhost binding by default;
- hashed static agent credentials;
- short-lived, mission-scoped session JWTs;
- explicit role and mission checks on every operation;
- lease fencing to reject late writes;
- size limits and Zod validation at the gateway;
- durable idempotency records;
- artifact content hashes;
- Ed25519-signed hash-chained events;
- no shell execution and no arbitrary URL fetching in the runtime;
- secrets are never included in mission snapshots or event payloads;
- dashboard requires the administrator token.

## Known v1 limits

- SQLite provides single-node durability, not Byzantine consensus.
- A malicious local administrator can alter the database or signing key.
- RelayMesh cannot prove that a remote model truthfully described work it did
  outside the runtime.
- Exactly-once external side effects require connector-specific idempotency.
- The MCP bridge inherits the security of the host that launches it.

Do not expose the v1 server directly to the public internet. Use a trusted
private network or reverse proxy with additional authentication if remote
access is required.
