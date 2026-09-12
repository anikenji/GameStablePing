import crypto from "node:crypto";

export interface TokenParams {
  userId: bigint;
  deviceKeyRaw: Buffer; // 65 bytes uncompressed P-256 (0x04...)
  expirySeconds: bigint;
  tier?: number; // default: 1 (VIP)
  maxSessions?: number; // default: 1
}

export function mintLicenceToken(privateKeyPem: string, params: TokenParams): Buffer {
  const { userId, deviceKeyRaw, expirySeconds, tier = 1, maxSessions = 1 } = params;

  if (deviceKeyRaw.length !== 65 || deviceKeyRaw[0] !== 4) {
    throw new Error("Invalid uncompressed P-256 public key (must be 65 bytes starting with 0x04)");
  }

  const tok = Buffer.alloc(150);
  tok[0] = 1; // TokenVersion = 1
  tok.writeBigUInt64BE(userId, 1);
  deviceKeyRaw.copy(tok, 9, 0, 65);
  tok.writeBigUInt64BE(expirySeconds, 74);
  tok[82] = tier;
  tok[83] = maxSessions;
  tok[84] = 0; // reserved
  tok[85] = 0; // reserved

  const payloadToSign = tok.subarray(0, 86);
  const sig = crypto.sign("SHA256", payloadToSign, {
    key: privateKeyPem,
    dsaEncoding: "ieee-p1363"
  });

  if (sig.length !== 64) {
    throw new Error("Signature length must be 64 bytes IEEE-P1363 (got " + sig.length + ")");
  }

  sig.copy(tok, 86, 0, 64);
  return tok;
}

export function verifyLicenceToken(publicKeyPem: string, tok: Buffer, nowSeconds: bigint): boolean {
  if (tok.length !== 150) return false;
  if (tok[0] !== 1) return false; // TokenVersion

  const expiry = tok.readBigUInt64BE(74);
  if (nowSeconds > expiry) return false; // Expired

  const payload = tok.subarray(0, 86);
  const sig = tok.subarray(86, 150);

  return crypto.verify("SHA256", payload, {
    key: publicKeyPem,
    dsaEncoding: "ieee-p1363"
  }, sig);
}
