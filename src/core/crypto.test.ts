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

  it("verifies session tokens against an injected clock and reports why one failed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relaymesh-crypto-clock-"));
    directories.push(directory);

    // Clock a year off the wall clock in BOTH directions, derived from
    // Date.now() at run time so this assertion can never rot into a time bomb
    // the way the fixed 2026-07-26 base date in runtime.test.ts did.
    const yearMs = 365 * 24 * 60 * 60 * 1_000;
    for (const offsetMs of [yearMs, -yearMs]) {
      let current = Date.now() + offsetMs;
      const authority = new SigningAuthority(directory, () => new Date(current));
      const issuedAt = Math.floor(current / 1_000);
      const token = await authority.issueSessionToken({
        type: "agent-session",
        sessionId: "session",
        agentId: "agent",
        missionId: "mission",
        role: "worker",
        capabilities: ["code.typescript"],
        jti: "jti",
        issuedAt,
        expiresAt: issuedAt + 60,
      });
      await expect(authority.verifySessionToken(token)).resolves.toMatchObject({
        sessionId: "session",
        issuedAt,
        expiresAt: issuedAt + 60,
      });

      // Expiry is still enforced, on the injected clock.
      current += 61_000;
      await expect(authority.verifySessionToken(token)).rejects.toMatchObject({
        code: "INVALID_TOKEN",
        details: { reason: "ERR_JWT_EXPIRED" },
      });

      // An expired token must be distinguishable from a forged one.
      current -= 61_000;
      await expect(
        authority.verifySessionToken(`${token}tampered`),
      ).rejects.toMatchObject({
        code: "INVALID_TOKEN",
        details: { reason: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" },
      });

      // An explicit per-call clock override wins over the injected clock.
      await expect(
        authority.verifySessionToken(token, new Date(current + 61_000)),
      ).rejects.toMatchObject({ details: { reason: "ERR_JWT_EXPIRED" } });
    }
  });

  it("defaults to the real wall clock when no clock is injected", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relaymesh-crypto-wall-"));
    directories.push(directory);
    const authority = new SigningAuthority(directory);

    const wallNow = Math.floor(Date.now() / 1_000);
    const live = await authority.issueSessionToken({
      type: "agent-session",
      sessionId: "live",
      agentId: "agent",
      missionId: "mission",
      role: "worker",
      capabilities: [],
      jti: "live-jti",
      issuedAt: wallNow,
      expiresAt: wallNow + 60,
    });
    await expect(authority.verifySessionToken(live)).resolves.toMatchObject({
      sessionId: "live",
    });

    const stale = await authority.issueSessionToken({
      type: "agent-session",
      sessionId: "stale",
      agentId: "agent",
      missionId: "mission",
      role: "worker",
      capabilities: [],
      jti: "stale-jti",
      issuedAt: wallNow - 120,
      expiresAt: wallNow - 60,
    });
    await expect(authority.verifySessionToken(stale)).rejects.toMatchObject({
      code: "INVALID_TOKEN",
      details: { reason: "ERR_JWT_EXPIRED" },
    });
  });
});
