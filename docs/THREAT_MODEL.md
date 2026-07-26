# Threat model

RelayMesh coordinates untrusted or partially trusted AI agents. Model output is
data, never authority.

## Protected assets

- mission context, checkpoints, messages, and artifacts;
- administrator, agent, session, MCP, and A2A credentials;
- task ownership, leases, and fencing tokens;
- event-log integrity and operator decisions.

## Trust boundaries

- Agent processes may be compromised, hallucinate, or ignore instructions.
- Model providers may observe data sent to their services.
- Other agents in a mission are not implicitly trusted.
- The local host and RelayMesh administrator are trusted in v0.4.

## Controls

- localhost binding by default;
- scrypt-hashed agent keys and scoped connection tickets;
- revocable tickets bound to one mission, agent, model, role, and capability set;
- short-lived, mission-scoped Ed25519 session JWTs;
- credential validation on every remote MCP and A2A request;
- lease fencing and atomic handoff to reject late model writes;
- strict schemas, body limits, rate limits, and log redaction;
- durable idempotency records and content-addressed artifacts;
- Ed25519-signed, per-mission hash-chained events;
- no shell execution or arbitrary URL fetching in the runtime;
- secrets excluded from mission snapshots and event payloads.

## Known limits

- SQLite provides single-node durability, not Byzantine consensus.
- A malicious local administrator can alter the database or signing key.
- RelayMesh cannot prove that a remote model truthfully described work it did
  outside the runtime.
- Exactly-once external side effects require connector-specific idempotency.
- A scoped MCP URL and an A2A Bearer ticket are credentials. Access logs must
  redact them.
- Public multi-user deployment needs standards-compliant user authentication,
  authorization policy, TLS, and operational hardening beyond the built-in
  development gateway.
- A2A streaming and push notifications are not implemented in v0.4.

Keep the default localhost bind unless RelayMesh is behind a trusted private
network or hardened HTTPS reverse proxy.
