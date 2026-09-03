import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose";
import { RelayError } from "./errors.js";

export interface SessionClaims {
  type: "agent-session";
  sessionId: string;
  agentId: string;
  missionId: string;
  role: string;
  capabilities: string[];
  jti: string;
  issuedAt: number;
  expiresAt: number;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const digest = scryptSync(secret, salt, 32);
  return `scrypt$${salt.toString("hex")}$${digest.toString("hex")}`;
}

export function verifySecret(secret: string, encoded: string): boolean {
  const [algorithm, saltHex, digestHex] = encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    saltHex === undefined ||
    digestHex === undefined
  ) {
    return false;
  }

  const expected = Buffer.from(digestHex, "hex");
  const actual = scryptSync(secret, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class SigningAuthority {
  readonly publicKeyPem: string;
  private readonly privateKeyPem: string;
  private readonly now: () => Date;

  /**
   * @param keyDirectory Directory holding the Ed25519 keypair.
   * @param now Clock used to validate `iat`/`exp` on session tokens. Defaults
   *   to the real wall clock, so production behaviour is unchanged; tests (and
   *   any caller that injects a clock into RelayRuntime) must pass the
   *   SAME clock they mint tokens with, otherwise every token verifies against
   *   a different timeline than it was issued on.
   */
  constructor(keyDirectory: string, now: () => Date = () => new Date()) {
    this.now = now;
    mkdirSync(keyDirectory, { recursive: true, mode: 0o700 });
    const privatePath = join(keyDirectory, "ed25519-private.pem");
    const publicPath = join(keyDirectory, "ed25519-public.pem");

    if (!existsSync(privatePath) || !existsSync(publicPath)) {
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      writeFileSync(
        privatePath,
        privateKey.export({ type: "pkcs8", format: "pem" }),
        { mode: 0o600 },
      );
      writeFileSync(
        publicPath,
        publicKey.export({ type: "spki", format: "pem" }),
        { mode: 0o644 },
      );
    }

    chmodSync(privatePath, 0o600);
    this.privateKeyPem = readFileSync(privatePath, "utf8");
    this.publicKeyPem = readFileSync(publicPath, "utf8");
  }

  signDigest(digestHex: string): string {
    return sign(
      null,
      Buffer.from(digestHex, "hex"),
      this.privateKeyPem,
    ).toString("base64url");
  }

  verifyDigest(digestHex: string, signature: string): boolean {
    return verify(
      null,
      Buffer.from(digestHex, "hex"),
      this.publicKeyPem,
      Buffer.from(signature, "base64url"),
    );
  }

  async issueSessionToken(claims: SessionClaims): Promise<string> {
    const key = await importPKCS8(this.privateKeyPem, "EdDSA");
    return new SignJWT({
      type: claims.type,
      sessionId: claims.sessionId,
      agentId: claims.agentId,
      missionId: claims.missionId,
      role: claims.role,
      capabilities: claims.capabilities,
    })
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
      .setIssuer("relaymesh")
      .setAudience("relaymesh-runtime")
      .setSubject(claims.agentId)
      .setJti(claims.jti)
      .setIssuedAt(claims.issuedAt)
      .setExpirationTime(claims.expiresAt)
      .sign(key);
  }

  /**
   * @param token The session JWT.
   * @param now Optional per-call clock override. Defaults to the authority's
   *   injected clock. `currentDate` is passed through to jose so that
   *   `iat`/`exp` are compared against the SAME clock the token was minted on
   *   rather than the real wall clock.
   */
  async verifySessionToken(
    token: string,
    now: Date = this.now(),
  ): Promise<SessionClaims> {
    try {
      const key = await importSPKI(this.publicKeyPem, "EdDSA");
      const { payload } = await jwtVerify(token, key, {
        issuer: "relaymesh",
        audience: "relaymesh-runtime",
        algorithms: ["EdDSA"],
        currentDate: now,
      });

      if (
        payload.type !== "agent-session" ||
        typeof payload.sessionId !== "string" ||
        typeof payload.agentId !== "string" ||
        typeof payload.missionId !== "string" ||
        typeof payload.role !== "string" ||
        !Array.isArray(payload.capabilities) ||
        payload.capabilities.some((item) => typeof item !== "string") ||
        typeof payload.jti !== "string" ||
        typeof payload.iat !== "number" ||
        typeof payload.exp !== "number"
      ) {
        throw new RelayError(
          401,
          "INVALID_TOKEN",
          "Session token claims are invalid",
        );
      }

      const capabilities = payload.capabilities.map((item) => String(item));
      return {
        type: "agent-session",
        sessionId: payload.sessionId,
        agentId: payload.agentId,
        missionId: payload.missionId,
        role: payload.role,
        capabilities,
        jti: payload.jti,
        issuedAt: payload.iat,
        expiresAt: payload.exp,
      };
    } catch (error) {
      if (error instanceof RelayError) {
        throw error;
      }
      // Preserve the underlying jose reason. Without it an EXPIRED token and a
      // FORGED token produce byte-identical logs, which is how the injected
      // test clock stayed broken for five weeks.
      throw new RelayError(
        401,
        "INVALID_TOKEN",
        "Session token is invalid",
        describeTokenFailure(error),
      );
    }
  }
}

export interface TokenFailureDetails {
  /** jose error code, e.g. ERR_JWT_EXPIRED or ERR_JWS_SIGNATURE_VERIFICATION_FAILED. */
  reason: string;
  /** jose error message. */
  detail: string;
  /** Claim that failed validation, when jose reported one. */
  claim?: string;
}

function describeTokenFailure(error: unknown): TokenFailureDetails {
  if (!(error instanceof Error)) {
    return { reason: "ERR_UNKNOWN", detail: String(error) };
  }

  const candidate = error as Error & { code?: unknown; claim?: unknown };
  const reason =
    typeof candidate.code === "string" ? candidate.code : "ERR_UNKNOWN";
  const details: TokenFailureDetails = { reason, detail: error.message };
  if (typeof candidate.claim === "string" && candidate.claim.length > 0) {
    details.claim = candidate.claim;
  }
  return details;
}

export function ensurePrivateFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    writeFileSync(path, `${content}\n`, { mode: 0o600 });
  }
  chmodSync(path, 0o600);
}
