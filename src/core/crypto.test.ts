import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  createSecret,
  hashSecret,
  sha256,
  SigningAuthority,
  verifySecret,
} from "./crypto.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("crypto primitives", () => {
  it("canonicalizes objects independent of insertion order", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(canonicalJson([3, null, "relay"])).toBe('[3,null,"relay"]');
    expect(canonicalJson(true)).toBe("true");
  });

  it("hashes and verifies secrets without retaining plaintext", () => {
    const secret = createSecret("test");
    const encoded = hashSecret(secret);
    expect(encoded).not.toContain(secret);
    expect(verifySecret(secret, encoded)).toBe(true);
    expect(verifySecret(`${secret}x`, encoded)).toBe(false);
    expect(verifySecret(secret, "sha256$not-supported")).toBe(false);
  });

  it("signs event digests and session JWTs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relaymesh-crypto-"));
    directories.push(directory);
    const authority = new SigningAuthority(directory);
    const digest = sha256("event");
    const signature = authority.signDigest(digest);
    expect(authority.verifyDigest(digest, signature)).toBe(true);
    expect(authority.verifyDigest(sha256("tampered"), signature)).toBe(false);

    const now = Math.floor(Date.now() / 1000);
    const token = await authority.issueSessionToken({
      type: "agent-session",
      sessionId: "session",
      agentId: "agent",
      missionId: "mission",
      role: "worker",
      capabilities: ["code.typescript"],
      jti: "jti",
      issuedAt: now,
      expiresAt: now + 60,
    });
    await expect(authority.verifySessionToken(token)).resolves.toMatchObject({
      sessionId: "session",
      missionId: "mission",
      capabilities: ["code.typescript"],
    });
    await expect(authority.verifySessionToken(`${token}tampered`)).rejects.toMatchObject({
      code: "INVALID_TOKEN",
      statusCode: 401,
    });

    const reopenedAuthority = new SigningAuthority(directory);
    expect(reopenedAuthority.publicKeyPem).toBe(authority.publicKeyPem);
    expect(reopenedAuthority.verifyDigest(digest, signature)).toBe(true);
  });
});
