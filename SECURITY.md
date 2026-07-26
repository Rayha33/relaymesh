# Security policy

## Supported versions

RelayMesh is pre-1.0. Security fixes are applied to the latest `main` branch.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose credentials,
mission data, or event-signing keys.

Use GitHub's private vulnerability reporting feature for this repository. Include:

- affected commit or version;
- reproduction steps;
- expected impact;
- whether credentials or mission data were accessed;
- suggested mitigation, if known.

You should receive an acknowledgment within seven days. Please allow a
reasonable remediation window before public disclosure.

## Deployment guidance

- Keep the default localhost bind unless a trusted private network or
  authenticated reverse proxy protects the server.
- Treat remote MCP agent keys as passwords. Send them only as Bearer tokens
  over HTTPS; never place them in URLs, logs, or committed client files.
- Scoped connection URLs are credentials designed for clients that cannot send
  custom headers. Give them short expiries, share them only with the intended
  client, protect upstream access logs, and revoke them immediately after
  suspected exposure.
- The built-in remote MCP transport is intended for private and developer
  connections. A multi-user public ChatGPT plugin must add standards-compliant
  OAuth and per-user authorization before deployment.
- Use a persistent, access-controlled data volume.
- Never commit `data/`, `.env`, administrator tokens, agent keys, or MCP
  configuration containing real credentials.
- Rotate an agent identity immediately if its key may have leaked.
- Back up the SQLite database together with `data/keys`; event signatures
  cannot be reproduced without the original signing key.
- Run `npm audit` and the repository checks before deployment.

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for assumptions and known
limits.
