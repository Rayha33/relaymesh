import { verify } from "node:crypto";
import {
  canonicalJson,
  sha256,
  type SigningAuthority,
} from "./crypto.js";
import type {
  CapsuleVerification,
  MissionCapsule,
  MissionCapsulePayload,
} from "./types.js";

export function sealMissionCapsule(
  payload: MissionCapsulePayload,
  signing: SigningAuthority,
): MissionCapsule {
  const payloadHash = sha256(canonicalJson(payload));
  return {
    ...payload,
    seal: {
      algorithm: "Ed25519",
      publicKey: signing.publicKeyPem,
      payloadHash,
      signature: signing.signDigest(payloadHash),
    },
  };
}

export function verifyMissionCapsule(
  capsule: MissionCapsule,
): CapsuleVerification {
  const { seal, ...payload } = capsule;
  const payloadHash = sha256(canonicalJson(payload));
  if (payloadHash !== seal.payloadHash) {
    return {
      valid: false,
      reason: "Capsule payload hash does not match its seal",
      payloadHash,
    };
  }
  try {
    const valid = verify(
      null,
      Buffer.from(payloadHash, "hex"),
      seal.publicKey,
      Buffer.from(seal.signature, "base64url"),
    );
    return {
      valid,
      reason: valid ? null : "Capsule signature is invalid",
      payloadHash,
    };
  } catch {
    return {
      valid: false,
      reason: "Capsule seal is malformed",
      payloadHash,
    };
  }
}
